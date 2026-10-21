#!/usr/bin/env python3
"""Upload a signed MCUboot image to OpenFloat over BLE (mcumgr / SMP).

The device runs MCUboot plus the Zephyr mcumgr server, which exposes the SMP
GATT service. This tool speaks the SMP binary framing directly (no new
dependencies beyond bleak) so a desktop can update the sensor without the
nRF Connect Device Manager phone app and without a debug probe.

Usage
-----
    # show the images currently known to MCUboot
    python tools/openfloat_ota.py --list

    # upload (accepts the signed .bin or the dfu_application.zip from CI)
    python tools/openfloat_ota.py --image artifacts/ota/dfu_application.zip

    # upload and reboot into the new image
    python tools/openfloat_ota.py --image firmware.signed.bin --reset

The uploaded image is installed as a *test* image: MCUboot boots it once and the
application confirms it after a couple of seconds (see confirm_image_work in
firmware/src/main.c). If the new firmware never confirms -- because it crashes
or hangs during init -- the next reset swaps the previous image back.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import struct
import sys
import time
import zipfile
from pathlib import Path

SMP_SERVICE = "8d53dc1d-1db7-4cd3-868b-8a527460aa84"
SMP_CHAR = "da2e7828-fbce-4e01-ae9e-261174997c48"
CONTROL_CHAR = "8f3f3b10-0f5a-4f4c-9a2d-000000000003"

# The SMP header's op byte is the mcumgr management operation: read commands
# (image state) use MGMT_OP_READ, write commands (upload, reset) use
# MGMT_OP_WRITE. The dispatcher rejects the wrong one with MGMT_ERR_EINVAL.
MGMT_OP_READ = 0
MGMT_OP_WRITE = 2
MGMT_OP_READ_RSP = 1
MGMT_OP_WRITE_RSP = 3
SMP_FLAG_RESPONSE = 0x01

GROUP_OS = 0
GROUP_IMG = 1
OS_MGMT_ID_RESET = 5
IMG_MGMT_ID_STATE = 0
IMG_MGMT_ID_UPLOAD = 1

MGMT_ERR_EOK = 0
MGMT_ERR_ENOMEM = 8


# --------------------------------------------------------------------------
# Minimal CBOR (RFC 8949 subset used by mcumgr: maps, arrays, ints, bstr, tstr,
# bool, null). Keeping this local avoids a dependency on a CBOR package.
# --------------------------------------------------------------------------
def _cbor_head(major: int, length: int) -> bytes:
    if length < 24:
        return bytes([(major << 5) | length])
    if length < 0x100:
        return bytes([(major << 5) | 24, length])
    if length < 0x10000:
        return bytes([(major << 5) | 25]) + struct.pack(">H", length)
    return bytes([(major << 5) | 26]) + struct.pack(">I", length)


def cbor_uint(value: int) -> bytes:
    return _cbor_head(0, value)


def cbor_bytes(value: bytes) -> bytes:
    return _cbor_head(2, len(value)) + value


def cbor_text(value: str) -> bytes:
    raw = value.encode()
    return _cbor_head(3, len(raw)) + raw


def cbor_map(items: dict) -> bytes:
    out = _cbor_head(5, len(items))
    for key, value in items.items():
        out += cbor_text(key) + value
    return out


def cbor_decode(data: bytes):
    value, offset = _cbor_decode(data, 0)
    if offset != len(data):
        raise ValueError(f"CBOR trailing bytes: {len(data) - offset}")
    return value


def _cbor_decode(data: bytes, offset: int):
    if offset >= len(data):
        raise ValueError("CBOR truncated")
    initial = data[offset]
    major, info = initial >> 5, initial & 0x1F
    offset += 1

    if info < 24:
        argument = info
    elif info == 24:
        argument = data[offset]
        offset += 1
    elif info == 25:
        argument = struct.unpack_from(">H", data, offset)[0]
        offset += 2
    elif info == 26:
        argument = struct.unpack_from(">I", data, offset)[0]
        offset += 4
    elif info == 27:
        argument = struct.unpack_from(">Q", data, offset)[0]
        offset += 8
    elif info == 31:
        # Indefinite length: the per-major-type code below reads until a break.
        argument = 0
    else:
        raise ValueError(f"unsupported CBOR additional info {info}")

    if major == 0:
        return argument, offset
    if major == 1:
        return -1 - argument, offset
    indefinite = info == 31
    if major == 2:
        if indefinite:
            chunks = b""
            while True:
                if data[offset] == 0xFF:
                    return chunks, offset + 1
                chunk, offset = _cbor_decode(data, offset)
                chunks += chunk
        return data[offset:offset + argument], offset + argument
    if major == 3:
        if indefinite:
            chunks = ""
            while True:
                if data[offset] == 0xFF:
                    return chunks, offset + 1
                chunk, offset = _cbor_decode(data, offset)
                chunks += chunk
        return data[offset:offset + argument].decode("utf-8", "replace"), offset + argument
    if major == 4:
        items = []
        if indefinite:
            while data[offset] != 0xFF:
                item, offset = _cbor_decode(data, offset)
                items.append(item)
            return items, offset + 1
        for _ in range(argument):
            item, offset = _cbor_decode(data, offset)
            items.append(item)
        return items, offset
    if major == 5:
        result = {}
        if indefinite:
            while data[offset] != 0xFF:
                key, offset = _cbor_decode(data, offset)
                value, offset = _cbor_decode(data, offset)
                result[key] = value
            return result, offset + 1
        for _ in range(argument):
            key, offset = _cbor_decode(data, offset)
            value, offset = _cbor_decode(data, offset)
            result[key] = value
        return result, offset
    if major == 6:  # tag: skip the tag, return the tagged item
        return _cbor_decode(data, offset)
    if major == 7:
        if info == 20:
            return False, offset
        if info == 21:
            return True, offset
        if info in (22, 23):
            return None, offset
        raise ValueError(f"unsupported CBOR simple value {info}")
    raise ValueError(f"unsupported CBOR major type {major}")


# --------------------------------------------------------------------------
# SMP over BLE
# --------------------------------------------------------------------------
class SmpClient:
    def __init__(self, client, char_uuid: str):
        self._client = client
        self._char = char_uuid
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._buffer = b""
        self._seq = 0

    async def start(self) -> None:
        await self._client.start_notify(self._char, self._on_notify)

    async def stop(self) -> None:
        try:
            await self._client.stop_notify(self._char)
        except Exception:
            pass

    def _on_notify(self, _sender, data: bytearray) -> None:
        self._queue.put_nowait(bytes(data))

    async def request(self, group: int, command: int, payload: bytes, timeout: float = 8.0,
                      op: int = MGMT_OP_WRITE) -> dict:
        self._seq = (self._seq + 1) & 0xFF
        seq = self._seq
        header = struct.pack(">BBHHBB", op, 0, len(payload), group, seq, command)
        await self._client.write_gatt_char(self._char, header + payload, response=False)

        deadline = time.monotonic() + timeout
        self._buffer = b""
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"SMP request group={group} id={command} timed out")
            try:
                chunk = await asyncio.wait_for(self._queue.get(), remaining)
            except asyncio.TimeoutError:
                raise TimeoutError(f"SMP request group={group} id={command} timed out") from None

            self._buffer += chunk
            if len(self._buffer) < 8:
                continue
            rsp_op, _flags, length, rsp_group, rsp_seq, rsp_id = struct.unpack(">BBHHBB", self._buffer[:8])
            # The server replies with READ_RSP/WRITE_RSP and leaves the flags
            # byte at 0, so the op code (not the flag) identifies a response.
            expected_rsp = MGMT_OP_READ_RSP if op == MGMT_OP_READ else MGMT_OP_WRITE_RSP
            if rsp_op != expected_rsp:
                self._buffer = b""
                continue
            if rsp_seq != seq:
                self._buffer = b""
                continue
            if len(self._buffer) < 8 + length:
                continue
            body = self._buffer[8:8 + length]
            self._buffer = b""
            return cbor_decode(body) if body else {}


def _mgmt_rc(response: dict) -> int:
    rc = response.get("rc")
    if isinstance(rc, int):
        return rc
    # Some mcumgr versions nest the result under "err" for groups that wrap
    # another protocol; image/OS responses are flat.
    return 0


def _smp_error(rc: int) -> str:
    names = {
        0: "EOK", 1: "EUNKNOWN", 2: "ENOMEM", 3: "EINVAL", 4: "ETIMEOUT",
        5: "ENOENT", 6: "EBADSTATE", 7: "EMSGSIZE", 8: "ENOTSUP",
        9: "ECORRUPT", 10: "EIO", 11: "EPERM",
    }
    return names.get(rc, f"rc={rc}")


# --------------------------------------------------------------------------
# Image handling
# --------------------------------------------------------------------------
def load_image(path: Path) -> bytes:
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            candidates = [n for n in archive.namelist() if n.endswith(".bin") and "signed" in n]
            if not candidates:
                candidates = [n for n in archive.namelist() if n.endswith(".bin")]
            if not candidates:
                raise SystemExit(f"{path}: no .bin inside the archive")
            data = archive.read(candidates[0])
            print(f"Image: {path.name}/{candidates[0]} ({len(data)} bytes)")
            return data

    data = path.read_bytes()
    print(f"Image: {path.name} ({len(data)} bytes)")
    return data


def image_version(data: bytes) -> str:
    """MCUboot image version ("maj.min.rev.build") from the signed header."""
    if len(data) < 0x1C:
        return ""
    major, minor = data[0x14], data[0x15]
    rev = struct.unpack_from("<H", data, 0x16)[0]
    build = struct.unpack_from("<I", data, 0x18)[0]
    return f"{major}.{minor}.{rev}.{build}"


def describe_images(response: dict) -> None:
    images = response.get("images") or []
    if not images:
        print("  (device reported no images)")
        return
    for image in images:
        version = image.get("version", "?")
        digest = image.get("hash", b"")
        if isinstance(digest, bytes) and digest:
            digest_text = digest[:8].hex()
        else:
            digest_text = "?"
        flags = []
        for key in ("active", "confirmed", "bootable", "permanent", "pending"):
            if image.get(key):
                flags.append(key)
        print(f"  slot {image.get('slot')}: version {version}  hash {digest_text}  "
              f"[{' '.join(flags)}]")


async def find_device(timeout: float):
    from bleak import BleakScanner

    print(f"Scanning for OpenFloat for {timeout:.0f} s...")
    devices = await BleakScanner.discover(timeout=timeout)
    for device in devices:
        if (device.name or "").startswith("OpenFloat"):
            print(f"Found {device.name} at {device.address}")
            return device
    print("No OpenFloat device found. Is it awake and not connected elsewhere?")
    print("Visible devices:", [(d.address, d.name) for d in devices])
    return None


async def run(args) -> int:
    from bleak import BleakClient

    device = await find_device(args.scan_timeout)
    if device is None:
        return 2

    async with BleakClient(device, timeout=30.0) as client:
        try:
            mtu = client.mtu_size
        except Exception:
            mtu = 0
        if not mtu or mtu <= 23:
            # WinRT reports the 23-byte ATT default even after MTU exchange; the
            # device negotiates 212 (CONFIG_BT_L2CAP_TX_MTU), i.e. 209 usable.
            mtu = 212
        payload_limit = max(64, (mtu - 3) if mtu else 244)
        chunk_size = args.chunk or max(48, min(160, payload_limit - 8 - 24))
        print(f"MTU {mtu or 'unknown'} -> {chunk_size}-byte image chunks")

        smp = SmpClient(client, SMP_CHAR)
        await smp.start()
        try:
            state = await smp.request(GROUP_IMG, IMG_MGMT_ID_STATE, cbor_map({}),
                                      op=MGMT_OP_READ)
            if _mgmt_rc(state) != MGMT_ERR_EOK:
                print(f"image list failed: {_smp_error(_mgmt_rc(state))}")
                return 3
            print("Current images:")
            describe_images(state)

            if args.list:
                return 0

            image = load_image(Path(args.image))
            digest = hashlib.sha256(image).digest()

            offset = 0
            started = time.monotonic()
            total = len(image)
            while offset < total:
                piece = image[offset:offset + chunk_size]
                fields = {
                    "image": cbor_uint(0),
                    "data": cbor_bytes(piece),
                    "off": cbor_uint(offset),
                    # Absent "upgrade" => test image, so MCUboot can roll back
                    # if this firmware never confirms itself.
                }
                if offset == 0:
                    # The first request must carry the total length and the image
                    # hash; mcumgr rejects it with EINVAL otherwise (and so does
                    # every later request, because the upload context is unset).
                    fields["len"] = cbor_uint(total)
                    fields["sha"] = cbor_bytes(digest)
                payload = cbor_map(fields)
                try:
                    response = await smp.request(GROUP_IMG, IMG_MGMT_ID_UPLOAD, payload, timeout=args.timeout)
                except TimeoutError as error:
                    print(f"\nupload stalled at offset {offset}: {error}")
                    return 4

                rc = _mgmt_rc(response)
                if rc != MGMT_ERR_EOK:
                    print(f"\nupload rejected at offset {offset}: {_smp_error(rc)}")
                    return 4

                offset += len(piece)
                done = offset / total
                elapsed = max(1e-3, time.monotonic() - started)
                print(f"\r  {offset}/{total} bytes ({done * 100:5.1f}%)  "
                      f"{offset / elapsed / 1024:5.1f} KiB/s", end="", flush=True)

                reported = response.get("off")
                if isinstance(reported, int) and reported != offset:
                    print(f"\noffset mismatch: device reports {reported}, expected {offset}")
                    return 4

            print()
            final = await smp.request(GROUP_IMG, IMG_MGMT_ID_STATE, cbor_map({}),
                                      op=MGMT_OP_READ)
            state_images = final.get("images") or []

            target_version = image_version(image)
            staged = next((info for info in state_images
                           if str(info.get("version")) == target_version and not info.get("active")),
                          None)
            if staged is None:
                print(f"WARNING: image {target_version} is not visible in the slot list")
            elif isinstance(staged.get("hash"), bytes) and staged["hash"]:
                # Writing the slot hash with confirm:false marks the image as a
                # test image; MCUboot then swaps it in on the next reset.
                rsp = await smp.request(GROUP_IMG, IMG_MGMT_ID_STATE,
                                        cbor_map({"hash": cbor_bytes(staged["hash"]),
                                                  "confirm": b"\xf4"}),
                                        op=MGMT_OP_WRITE)
                rc = _mgmt_rc(rsp)
                print(f"=== staged {target_version} in slot {staged.get('slot')} as a test image"
                      + ("" if rc == 0 else f" (FAILED: {_smp_error(rc)})"))

            print("Images after staging:")
            describe_images(await smp.request(GROUP_IMG, IMG_MGMT_ID_STATE, cbor_map({}),
                                              op=MGMT_OP_READ))

            if args.reset:
                print("Rebooting into the new image...")
                rc = 0
                try:
                    rc = _mgmt_rc(await smp.request(GROUP_OS, OS_MGMT_ID_RESET,
                                                    cbor_map({}), timeout=3.0))
                except TimeoutError:
                    rc = 0  # rebooting before answering is fine
                if rc != 0:
                    # This build has no mcumgr OS-reset command; the firmware
                    # exposes a plain "reboot" command on the control service.
                    await client.write_gatt_char(CONTROL_CHAR, b"reboot", response=True)
                    print("Sent the 'reboot' control command.")
                else:
                    print("Device acknowledged the reset.")
            else:
                print("Image is staged; reboot the device to run it (or pass --reset).")
            return 0
        finally:
            await smp.stop()


async def run_with_retry(args) -> int:
    # The Windows WinRT BLE stack intermittently cancels GATT operations right
    # after a reconnect; retrying the whole session is the reliable fix.
    for attempt in range(1, 4):
        try:
            return await run(args)
        except OSError as error:
            print(f"\nBLE stack error (attempt {attempt}/3): {error}")
            await asyncio.sleep(3)
    return 3


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", help="signed .bin or dfu_application.zip to upload")
    parser.add_argument("--list", action="store_true", help="only print the image list")
    parser.add_argument("--reset", action="store_true", help="reset the device after upload")
    parser.add_argument("--chunk", type=int, default=0, help="image bytes per SMP packet")
    parser.add_argument("--scan-timeout", type=float, default=12.0)
    parser.add_argument("--timeout", type=float, default=8.0, help="per-packet response timeout")
    args = parser.parse_args()
    if not args.list and not args.image:
        parser.error("pass --list or --image")
    try:
        return asyncio.run(run_with_retry(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
