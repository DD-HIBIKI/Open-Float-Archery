# 快速上手

做一支 OpenFloat 传感器，烧录固件，再把实时遥测数据流式传输到这个 Web 应用。
首次搭建大约需要一小时，其中大部分时间是一次性安装固件工具链。

---

## 浏览器兼容性

### 实时传感器可用的浏览器

| 浏览器与平台 | 蓝牙传感器直连 |
| --- | --- |
| Windows 或 macOS 上的 Chrome 或 Edge | 受支持的浏览器方式 |
| Android 或 ChromeOS 上的 Chrome | 受支持的浏览器方式 |
| Firefox 或 Safari | Web Bluetooth 不可用 |
| iPhone/iPad 上的 Safari、Chrome 或 Edge | Web Bluetooth 不可用 |
| Linux 上的 Chromium | 取决于平台；默认不可用 |

浏览器支持情况会随时间变化。参见 [Web Bluetooth 兼容性数据](https://github.com/mdn/browser-compat-data/blob/main/api/Bluetooth.json)
和 [Chrome 支持的平台](https://developer.chrome.com/docs/capabilities/bluetooth)。
应用会检查浏览器中实际可用的 Bluetooth API。当传感器访问不可用时，
浏览器提示会说明传感器为何不可用，并链接回本节。

### 安全页面与本地服务

通过 HTTPS 打开 [OpenFloat](https://openfloatarchery.com)，或在运行本应用的电脑上使用
`http://localhost:4178`。家庭网络中的普通 HTTP 地址无法提供蓝牙所需的安全上下文。
手机上的 `localhost` 指的是手机自身。参见 [安全上下文](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)。

如果嵌入式页面阻止了蓝牙，请直接在标签页中打开本应用。打开电脑或手机的蓝牙，
唤醒传感器，然后在浏览器的选择器中选择它。仅凭浏览器支持并不能说明无线电或传感器已就绪。

### 演示与已保存数据

演示、已存箭以及本地备份/恢复无需 Web Bluetooth 也能使用。试试页头的 **演示** 按钮，
或在设置中导入已有的 JSON 采集文件。传感器支持检查不会清除录制内容，也不会中断正在运行的演示。
把站点安装为应用后，仍沿用同一浏览器的蓝牙要求。

---

## 1. 所需材料

**硬件**

- **Seeed Studio XIAO nRF54L15 Sense** —— 微控制器 + BLE + 板载
  IMU（`LSM6DS3TR-C`）和 PDM 麦克风。它是整台设备的大脑。
- **3.7 V LiPo 电池**，约 70 mAh，带保护电路，用于在靶场上脱机使用。
  （调试阶段也可以直接用 USB 供电。）
- **安装胶泥** —— 一小团可移除的黏性胶泥就足以把板子粘到弓上。
  安装的一致性会影响数据质量。
- **USB-C 数据线**，用于把 XIAO 连接到电脑烧录固件。

**软件**

- **Chromium 内核浏览器**（Chrome 或 Edge）—— 需要 Web Bluetooth，
  Firefox 和 Safari 不支持。
- **nRF Connect SDK (NCS) v3.3.0** 工具链，用于构建固件。
  XIAO nRF54L15 开发板已内置于 NCS v3.3.0 —— 无需额外的板级包。
- **OpenOCD**，用于通过开发板的 CMSIS-DAP 调试接口烧录构建产物。

> 固件工具链只需安装一次。之后重新烧录就是两条命令的事。

---

## 2. 组装硬件

1. 把电池引线（或 JST 连接器）焊到 XIAO 的 `BAT+` / `BAT-` 焊盘上，注意极性。
   如果只打算用 USB 供电，可跳过这一步。
2. 在弓上按一小团安装胶泥，把板子牢牢压上去，使其刚性固定 ——
   任何形变或晃动都会在轨迹里表现为噪声。确保粘得足够牢固，
   使它**不会变成抛射物**，也不会在撒放冲击下干扰弓。
3. 记下板子在弓上的朝向。稍后可用应用内的轴映射和 **零点标定** 按钮把它校正过来 ——
   机械上不必完全对齐。

> **安全提示：** OpenFloat 是一个实验性的爱好者/教学项目，不是安全装置。
> 请始终遵守靶场的常规安全规则。

---

## 3. 构建固件

> 从[最新的 GitHub Release](https://github.com/DevanMetz/Open-Float-Archery/releases/latest)
> 下载预编译的 `merged.hex`，即可**完全跳过这一步** ——
> CI 会基于打标签的源码构建它。烧录仍需 OpenOCD（第 4 步），但不需要 NCS 工具链。

固件位于 `firmware/`，目标板为 `xiao_nrf54l15/nrf54l15/cpuapp`。
请使用 NCS v3.3.0 工具链构建。在典型的 Windows 安装上，实测可用的命令是：

```powershell
& "C:\ncs\toolchains\b8b84efebd\nrfutil\bin\nrfutil.exe" toolchain-manager launch `
  --ncs-version v3.3.0 `
  --chdir "C:\ncs\v3.3.0" `
  -- west build `
  -p always `
  -b xiao_nrf54l15/nrf54l15/cpuapp `
  -d "firmware\build-v3.3.0" `
  "firmware"
```

构建成功后产出：

```text
firmware/build-v3.3.0/merged.hex
```

默认配置是**电池安全**的：它禁用了 USB UART 控制台，以便开发板可用 LiPo 供电启动。
如果你需要在台面上查看串口日志，请加上 USB overlay：

```powershell
-DOVERLAY_CONFIG=prj_uart.conf
```

> 下面两条警告是预期内且无害的：
> `SB_CONFIG_PARTITION_MANAGER ... deprecated` 和
> `BT_HCI_TX_STACK_SIZE was assigned 2048 but got 1536`。

完整的构建、烧录与验证指南 —— 包括 USB 串口 overlay 和调参项 ——
见 [firmware/BUILDING.md](../firmware/BUILDING.md)。

---

## 4. 烧录固件

用 USB 连接 XIAO，并通过开发板的 CMSIS-DAP 探针用 OpenOCD 烧录 `merged.hex`：

```powershell
openocd `
  -s "<seeed-support>/boards/arm/xiao_nrf54l15/support" `
  -s "C:/Program Files/OpenOCD/share/openocd/scripts" `
  -c "adapter serial <YOUR_PROBE_SERIAL>" `
  -f "<seeed-support>/boards/arm/xiao_nrf54l15/support/openocd.cfg" `
  -c "init" `
  -c "reset init" `
  -c "nrf54l-load firmware/build-v3.3.0/merged.hex" `
  -c "verify_image firmware/build-v3.3.0/merged.hex" `
  -c "reset run" `
  -c "shutdown"
```

把 `<YOUR_PROBE_SERIAL>` 换成探针的 CMSIS-DAP 序列号，把 `<seeed-support>` 换成
Seeed 支持文件的路径。烧录完成后，开发板会复位，新固件立即运行。

---

## 5. 验证运行

烧录后，固件会以 **`OpenFloat-XXXX`** 为设备名通过 BLE 广播，并让用户 LED 闪烁。
此时已经可以连接 Web 应用了。

如果你构建时启用了 USB UART overlay，也可以通过 **115200 波特率**的串口确认启动。
在 DTR/RTS 置位的情况下打开端口，然后复位开发板；你应该会看到：

```text
*** Booting nRF Connect SDK v3.3.0 ***
# OPENFLOAT_PROTO,1
# target: Seeed XIAO nRF54L15 Sense
# imu_odr_hz: 3332
# IMU ready: ... accel+gyro ODR 3332 Hz ...
OFRAW,1,0,77728,900, ...
```

状态正常的设备会以约 1110 帧/秒的平均速率输出，且 FIFO 零溢出。

---

如果用户 LED 反复双闪，且传感器没有在广播，说明固件正在等待存储恢复。
它会在三十秒后重试，而不是带着未读取的计数器或箭队列启动。
USB UART overlay 会报告恢复失败的键/错误。启动与 LED 行为仍需在真机上验证。

## 6. 打开 Web 应用

在 localhost 上托管仓库根目录（原生 ES 模块需要 HTTP 源；
Web Bluetooth 还需要 HTTPS 或可信的本地源）：

```powershell
python -m http.server 4178
```

然后在 Chrome 或 Edge 中打开 **http://localhost:4178/**。应用加载后也可完全离线运行，
托管版本位于 `openfloatarchery.com`。

---

## 7. 通过蓝牙连接

1. 给传感器上电（电池或 USB），并移动它使其唤醒。
2. 在应用页头激活 **未连接** 传感器按钮（右上角）。
   也可以用 Tab 键定位后按 Enter 或空格键操作。
3. 在浏览器的蓝牙选择器中选择你的 **`OpenFloat-XXXX`** 设备并配对。
4. 徽标变绿，仪表盘开始接收数据：弓朝向可视化开始移动，撒放序列轨迹逐渐填满，
   实时速率显示约 1110 Hz。

如果链路断开，应用会自动重试（最多 6 次，带退避），固件也会恢复广播 ——
通常它会自行重连。

![仪表盘实时数据：水平泡、3D 弓可视化与实时轨迹](images/dashboard-live.png)

> 还没有传感器？页头的 **▶ 演示** 按钮会推送合成运动数据，
> 让你先把整个仪表盘探索一遍。

---

## 8. 首次标定

1. 以你平常的水平射击姿势持弓。
2. 在仪表盘上点击 **零点标定**，把当前的横滚和俯仰记录为水平基准。
   水平泡和 3D 弓现在应显示为水平。
3. 如果屏幕上的弓相对你实际的安装方向有旋转，请打开
   **设置 → 传感器与 3D 对齐**，调整安装轴映射，直到模型与实际情况一致。

就这样 —— 射出一箭，它就会带着 OpenFloat Float Score 出现在 **最近箭** 中。
接下来可以试试 **稳定瞄准** 的保持练习，以及 **已存箭** 的场次复盘。
