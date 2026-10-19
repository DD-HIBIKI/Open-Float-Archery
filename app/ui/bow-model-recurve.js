// Procedural Olympic recurve bow model.
//
// The builder receives the Three.js module namespace from the caller so this
// module never imports a specific bundle URL itself:
//
//   const THREE = await import(THREE_URL);
//   const bow = buildRecurveBowModel(THREE);
//
// Axis convention matches the existing compound model measured in the app:
//   +Y  up / down (bow height)
//   +X  toward the archer (string side), -X toward the target (sight side)
//   +Z  the thin bow axis, origin at the grip centre
//
// Measured bounds (Box3.setFromObject):
//   min [-3.214, -5.490, -0.240]  max [1.583, 5.490, 0.791]
//   size [4.80, 10.98, 1.03]
//
// Part group names: Riser, Top_Limb, Bottom_Limb, String, Sight, Stabilizer,
// Grip. Materials: "riser", "limb", "grip", "string", "sight" (lowercase).

const COLORS = {
  riser: 0x35c7e8,
  limb: 0x30e39b,
  string: 0xe6f4ef,
  sight: 0xffbe5c,
  grip: 0x1b6b7a,
};

const PART_NAMES = [
  "Riser",
  "Top_Limb",
  "Bottom_Limb",
  "String",
  "Sight",
  "Stabilizer",
  "Grip",
];

// Side profile (X-Y) of the riser. The loop runs up the target side (-X),
// across the top limb pocket, down the archer side (+X), and around the open
// sight window notch above the grip before closing along the bottom pocket.
const RISER_OUTLINE = [
  // bottom limb pocket, then up the target side (-X)
  [-0.30, -3.30],
  [-0.52, -3.18],
  [-0.68, -2.98],
  [-0.76, -2.72],
  [-0.80, -2.40],
  [-0.83, -2.05],
  [-0.86, -1.68],
  [-0.89, -1.28],
  [-0.92, -0.85],
  [-0.95, -0.38],
  [-0.97, 0.10],
  [-0.95, 0.58],
  [-0.92, 1.05],
  [-0.89, 1.50],
  [-0.87, 1.88],
  [-0.86, 2.10],
  // upper arm: the back edge sweeps in toward the top limb pocket
  [-0.82, 2.35],
  [-0.74, 2.60],
  [-0.60, 2.84],
  [-0.44, 3.04],
  [-0.34, 3.20],
  [-0.28, 3.30],
  // top limb pocket roof
  [-0.10, 3.34],
  [0.08, 3.30],
  // upper arm, archer side, coming down to the window lip
  [0.08, 3.06],
  [0.03, 2.80],
  [-0.03, 2.55],
  [-0.10, 2.32],
  // sight window, upper lip
  [-0.19, 2.16],
  [-0.26, 2.04],
  [-0.28, 1.86],
  // sight window inner wall (deep cut so the window reads as an opening)
  [-0.29, 1.55],
  [-0.29, 1.10],
  [-0.28, 0.70],
  [-0.26, 0.40],
  // sight window lower lip / arrow shelf
  [-0.20, 0.26],
  [-0.06, 0.18],
  [0.12, 0.14],
  // grip throat, grip bulge and lower arm
  [0.30, 0.12],
  [0.46, 0.04],
  [0.55, -0.14],
  [0.58, -0.38],
  [0.56, -0.62],
  [0.51, -0.86],
  [0.45, -1.12],
  [0.38, -1.42],
  [0.32, -1.74],
  [0.26, -2.06],
  [0.20, -2.38],
  [0.14, -2.68],
  [0.08, -2.96],
  [0.03, -3.18],
  [0.01, -3.30],
];

// Ergonomic grip pad: a tapered rounded section swept down the archer side of
// the riser. The centreline tracks the riser's throat (about 0.02 inside it) and
// both ends taper into the riser, so no seam or cap is visible.
const GRIP_POINTS = [
  [0.33, 0.10],
  [0.45, 0.02],
  [0.51, -0.10],
  [0.55, -0.28],
  [0.55, -0.45],
  [0.53, -0.66],
  [0.49, -0.84],
  [0.46, -0.96],
];
const GRIP_WIDTH = 0.34;
const GRIP_THICKNESS = 0.34;

// Limb centreline, root -> tip, for the top limb. The curve first sweeps to
// the target side (mid limb around X = -0.55) and then recurves back toward the
// archer, ending at the string plane (X = +1.55, Y = +5.42). The bottom limb is
// the same curve mirrored through Y = 0.
const TOP_LIMB_POINTS = [
  [-0.02, 3.02],
  [-0.20, 3.38],
  [-0.42, 3.80],
  [-0.55, 4.22],
  [-0.56, 4.60],
  [-0.40, 4.93],
  [-0.08, 5.16],
  [0.40, 5.31],
  [0.95, 5.39],
  [1.42, 5.42],
  [1.55, 5.42],
];

const STRING_X = 1.55;
const STRING_TIP_Y = 5.42;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function makeMaterial(THREE, name, color, metalness, roughness) {
  const material = new THREE.MeshStandardMaterial({
    name,
    color,
    metalness,
    roughness,
  });
  return material;
}

function buildMaterials(THREE) {
  return {
    riser: makeMaterial(THREE, "riser", COLORS.riser, 0.34, 0.34),
    limb: makeMaterial(THREE, "limb", COLORS.limb, 0.06, 0.6),
    string: makeMaterial(THREE, "string", COLORS.string, 0.0, 0.48),
    sight: makeMaterial(THREE, "sight", COLORS.sight, 0.38, 0.3),
    grip: makeMaterial(THREE, "grip", COLORS.grip, 0.08, 0.78),
  };
}

// Closed smooth outline through the given X-Y points.
function makeSmoothClosedShape(THREE, points, samplesPerSegment = 8) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, y]) => new THREE.Vector3(x, y, 0)),
    true,
    "catmullrom",
    0.5,
  );
  const sampled = curve.getPoints(points.length * samplesPerSegment);
  const shape = new THREE.Shape();
  sampled.forEach((point, index) => {
    if (index === 0) {
      shape.moveTo(point.x, point.y);
    } else {
      shape.lineTo(point.x, point.y);
    }
  });
  shape.closePath();
  return shape;
}

function roundedRectShape(THREE, centerX, centerY, width, height, radius) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const r = Math.min(radius, halfWidth, halfHeight);
  const shape = new THREE.Shape();
  shape.moveTo(centerX - halfWidth + r, centerY - halfHeight);
  shape.lineTo(centerX + halfWidth - r, centerY - halfHeight);
  shape.quadraticCurveTo(centerX + halfWidth, centerY - halfHeight, centerX + halfWidth, centerY - halfHeight + r);
  shape.lineTo(centerX + halfWidth, centerY + halfHeight - r);
  shape.quadraticCurveTo(centerX + halfWidth, centerY + halfHeight, centerX + halfWidth - r, centerY + halfHeight);
  shape.lineTo(centerX - halfWidth + r, centerY + halfHeight);
  shape.quadraticCurveTo(centerX - halfWidth, centerY + halfHeight, centerX - halfWidth, centerY + halfHeight - r);
  shape.lineTo(centerX - halfWidth, centerY - halfHeight + r);
  shape.quadraticCurveTo(centerX - halfWidth, centerY - halfHeight, centerX - halfWidth + r, centerY - halfHeight);
  shape.closePath();
  return shape;
}

// Extrude an X-Y shape along Z, centred on Z = 0, with rounded edges.
function extrudedGeometry(THREE, shape, depth, bevel = 0.02) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 24,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

// Sweep a softly octagonal, optionally tapered cross-section along a curve in
// the X-Y plane. Width runs along Z, thickness along the in-plane normal, so the
// limbs keep their flat-ribbon profile and the grip becomes a rounded pad.
function sweptRibbonGeometry(THREE, points, options = {}) {
  const segments = options.segments || 96;
  const widthAt = options.widthAt || (() => 0.18);
  const thicknessAt = options.thicknessAt || (() => 0.1);
  const roundness = options.roundness ?? 0.42;

  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, y]) => new THREE.Vector3(x, y, 0)),
    false,
    "catmullrom",
    0.5,
  );

  const ringSize = 8;
  const positions = [];
  const indices = [];
  const centers = [];
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3(0, 0, 1);
  const offset = new THREE.Vector3();

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    curve.getPoint(t, point);
    curve.getTangent(t, tangent).normalize();
    // In-plane normal of the centreline (always lies in X/Y).
    normal.set(-tangent.y, tangent.x, 0).normalize();

    const halfWidth = widthAt(t) / 2;
    const halfThickness = thicknessAt(t) / 2;
    const cutU = Math.min(halfThickness * roundness, halfWidth * 0.5);
    const cutV = Math.min(halfWidth * roundness, halfThickness * 0.9);

    const section = [
      [halfThickness, halfWidth - cutV],
      [halfThickness - cutU, halfWidth],
      [-halfThickness + cutU, halfWidth],
      [-halfThickness, halfWidth - cutV],
      [-halfThickness, -halfWidth + cutV],
      [-halfThickness + cutU, -halfWidth],
      [halfThickness - cutU, -halfWidth],
      [halfThickness, -halfWidth + cutV],
    ];

    centers.push(point.clone());
    for (const [u, v] of section) {
      offset.copy(normal).multiplyScalar(u).addScaledVector(binormal, v);
      positions.push(point.x + offset.x, point.y + offset.y, point.z + offset.z);
    }
  }

  for (let i = 0; i < segments; i += 1) {
    for (let j = 0; j < ringSize; j += 1) {
      const j2 = (j + 1) % ringSize;
      const a = i * ringSize + j;
      const b = i * ringSize + j2;
      const c = (i + 1) * ringSize + j2;
      const d = (i + 1) * ringSize + j;
      indices.push(a, b, c, a, c, d);
    }
  }

  // Caps: flat octagonal lids at the riser pocket and at the limb tip.
  const startCenter = positions.length / 3;
  positions.push(centers[0].x, centers[0].y, centers[0].z);
  const endCenter = positions.length / 3;
  const lastCenter = centers[centers.length - 1];
  positions.push(lastCenter.x, lastCenter.y, lastCenter.z);
  for (let j = 0; j < ringSize; j += 1) {
    const j2 = (j + 1) % ringSize;
    indices.push(startCenter, j2, j);
    const base = segments * ringSize;
    indices.push(endCenter, base + j, base + j2);
  }

  // Keep the surface winding outward regardless of the curve direction.
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  if (volume < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const swapped = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = swapped;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Narrow the riser towards the limb pockets like a machined riser blank.
function taperRiserDepth(geometry, minY, maxY, amount) {
  const position = geometry.getAttribute("position");
  const smoothstep = (edge0, edge1, value) => {
    const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < position.count; i += 1) {
    const y = position.getY(i);
    const factor = 1 - amount * smoothstep(minY, maxY, Math.abs(y));
    position.setZ(i, position.getZ(i) * factor);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function addCylinderBetween(THREE, parent, start, end, radius, material, radialSegments = 20) {
  const a = new THREE.Vector3(...start);
  const b = new THREE.Vector3(...end);
  const direction = new THREE.Vector3().subVectors(b, a);
  const length = direction.length();
  const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, radialSegments, 1),
    material,
  );
  cylinder.position.copy(a).addScaledVector(direction, 0.5);
  if (length > 0) {
    cylinder.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize(),
    );
  }
  parent.add(cylinder);
  return cylinder;
}

function addMesh(THREE, parent, geometry, material, name, position = null, rotation = null) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  if (position) mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  parent.add(mesh);
  return mesh;
}

function buildRiser(THREE, materials) {
  const group = new THREE.Group();
  group.name = "Riser";
  group.userData.part = "Riser";

  const shape = makeSmoothClosedShape(THREE, RISER_OUTLINE, 8);
  // Machined cut-outs in the lower riser and above the sight window.
  shape.holes.push(roundedRectShape(THREE, -0.40, -2.00, 0.34, 0.85, 0.16));
  shape.holes.push(roundedRectShape(THREE, -0.45, 2.45, 0.18, 0.34, 0.08));

  const bodyGeometry = extrudedGeometry(THREE, shape, 0.40, 0.02);
  taperRiserDepth(bodyGeometry, 2.15, 3.30, 0.30);
  const body = new THREE.Mesh(bodyGeometry, materials.riser);
  body.name = "Riser";
  group.add(body);

  // Limb pockets and their locking bolts at both ends of the riser.
  for (const sign of [1, -1]) {
    const pocket = addMesh(
      THREE,
      group,
      new THREE.BoxGeometry(0.34, 0.24, 0.30),
      materials.riser,
      sign > 0 ? "Top_Limb_Pocket" : "Bottom_Limb_Pocket",
      [-0.18, sign * 3.14, 0],
    );
    pocket.userData.part = "Riser";
    const bolt = addCylinderBetween(
      THREE,
      group,
      [-0.18, sign * 3.16, -0.24],
      [-0.18, sign * 3.16, 0.24],
      0.055,
      materials.sight,
      16,
    );
    bolt.name = sign > 0 ? "Top_Limb_Bolt" : "Bottom_Limb_Bolt";
  }

  // Arrow rest, plunger button and clicker sitting in the sight window.
  const restPlate = addMesh(
    THREE,
    group,
    new THREE.BoxGeometry(0.10, 0.18, 0.05),
    materials.sight,
    "Arrow_Rest_Plate",
    [-0.24, 0.18, 0.26],
  );
  restPlate.userData.part = "Riser";
  const restFinger = addCylinderBetween(
    THREE,
    group,
    [-0.24, 0.18, 0.26],
    [-0.10, 0.24, 0.40],
    0.022,
    materials.sight,
    12,
  );
  restFinger.name = "Arrow_Rest_Finger";

  const plunger = addCylinderBetween(
    THREE,
    group,
    [-0.26, 0.32, 0.14],
    [-0.26, 0.32, 0.36],
    0.05,
    materials.sight,
    16,
  );
  plunger.name = "Plunger";

  const clicker = addMesh(
    THREE,
    group,
    new THREE.BoxGeometry(0.04, 0.40, 0.08),
    materials.sight,
    "Clicker",
    [-0.29, 0.85, 0.28],
    [0, 0, 0.08],
  );
  clicker.userData.part = "Riser";

  return group;
}

function buildLimb(THREE, points, name, materials) {
  const group = new THREE.Group();
  group.name = name;
  group.userData.part = name;

  const mesh = new THREE.Mesh(
    sweptRibbonGeometry(THREE, points, {
      widthAt: (t) => lerp(0.18, 0.078, Math.pow(t, 0.9)),
      thicknessAt: (t) => lerp(0.12, 0.055, Math.pow(t, 0.72)),
    }),
    materials.limb,
  );
  mesh.name = name;
  group.add(mesh);

  // Limb tip overlay so the string loop has something to sit in.
  const tip = points[points.length - 1];
  const tipBlock = addMesh(
    THREE,
    group,
    new THREE.BoxGeometry(0.22, 0.085, 0.105),
    materials.limb,
    `${name}_Tip`,
    [tip[0] - 0.10, tip[1], 0],
    [0, 0, -0.10],
  );
  tipBlock.userData.part = name;

  return group;
}

function buildString(THREE, materials) {
  const group = new THREE.Group();
  group.name = "String";
  group.userData.part = "String";

  const shaft = addCylinderBetween(
    THREE,
    group,
    [STRING_X, STRING_TIP_Y + 0.01, 0],
    [STRING_X, -STRING_TIP_Y - 0.01, 0],
    0.02,
    materials.string,
    10,
  );
  shaft.name = "String";
  shaft.userData.part = "String";

  // Serving and nocking point at the arrow height.
  const serving = addCylinderBetween(
    THREE,
    group,
    [STRING_X, 0.86, 0],
    [STRING_X, -0.10, 0],
    0.029,
    materials.string,
    10,
  );
  serving.name = "String_Serving";
  const nocking = addCylinderBetween(
    THREE,
    group,
    [STRING_X, 0.40, 0],
    [STRING_X, 0.30, 0],
    0.035,
    materials.string,
    10,
  );
  nocking.name = "String_Nocking_Point";

  // String end loops wrapped around the limb tips.
  for (const sign of [1, -1]) {
    const loop = new THREE.Mesh(
      new THREE.TorusGeometry(0.055, 0.015, 8, 24),
      materials.string,
    );
    loop.name = sign > 0 ? "String_Top_Loop" : "String_Bottom_Loop";
    loop.position.set(STRING_X, sign * STRING_TIP_Y, 0);
    loop.rotation.y = Math.PI / 2;
    group.add(loop);
  }

  return group;
}

function buildSight(THREE, materials) {
  const group = new THREE.Group();
  group.name = "Sight";
  group.userData.part = "Sight";

  // Dovetail block, bolted onto the inside wall of the sight window.
  addMesh(
    THREE,
    group,
    new THREE.BoxGeometry(0.28, 0.18, 0.16),
    materials.sight,
    "Sight_Dovetail",
    [-0.15, 0.55, 0.30],
  );

  // Extension bar reaching forward (-X) and slightly up / outboard (+Z).
  const extensionBar = addCylinderBetween(
    THREE,
    group,
    [-0.18, 0.55, 0.32],
    [-1.46, 0.78, 0.46],
    0.028,
    materials.sight,
    14,
  );
  extensionBar.name = "Sight_Extension";

  // Elevation post at the end of the extension bar.
  addMesh(
    THREE,
    group,
    new THREE.BoxGeometry(0.07, 0.42, 0.10),
    materials.sight,
    "Sight_Vertical_Bar",
    [-1.47, 0.78, 0.46],
  );

  // Windage bar carrying the scope ring in front of the archer's eye.
  const windageBar = addCylinderBetween(
    THREE,
    group,
    [-1.49, 0.94, 0.46],
    [-1.86, 0.94, 0.56],
    0.02,
    materials.sight,
    12,
  );
  windageBar.name = "Sight_Windage";

  // Scope ring facing the archer (axis along X), with a pin and a fibre dot.
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.2, 0.021, 12, 40),
    materials.sight,
  );
  ring.name = "Sight_Ring";
  ring.position.set(-1.90, 0.94, 0.57);
  ring.rotation.y = Math.PI / 2;
  group.add(ring);

  const pin = addCylinderBetween(
    THREE,
    group,
    [-1.90, 0.76, 0.57],
    [-1.90, 1.12, 0.57],
    0.006,
    materials.sight,
    8,
  );
  pin.name = "Sight_Pin";
  addMesh(
    THREE,
    group,
    new THREE.SphereGeometry(0.026, 12, 10),
    materials.sight,
    "Sight_Fibre",
    [-1.90, 0.94, 0.57],
  );

  return group;
}

function buildStabilizer(THREE, materials) {
  const group = new THREE.Group();
  group.name = "Stabilizer";
  group.userData.part = "Stabilizer";

  const mount = addMesh(
    THREE,
    group,
    new THREE.BoxGeometry(0.24, 0.30, 0.22),
    materials.grip,
    "Stabilizer_Mount",
    [-1.02, -1.30, 0],
  );
  mount.userData.part = "Stabilizer";

  const rodStart = new THREE.Vector3(-1.14, -1.36, 0);
  const rodEnd = new THREE.Vector3(-3.18, -1.72, 0);
  const rod = addCylinderBetween(
    THREE,
    group,
    [rodStart.x, rodStart.y, rodStart.z],
    [rodEnd.x, rodEnd.y, rodEnd.z],
    0.046,
    materials.riser,
    16,
  );
  rod.name = "Stabilizer_Rod";

  const direction = new THREE.Vector3().subVectors(rodEnd, rodStart).normalize();
  const placeOnRod = (distanceFromStart, radius, length, material, name) => {
    const center = new THREE.Vector3().copy(rodStart).addScaledVector(direction, distanceFromStart);
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, length, 20, 1),
      material,
    );
    mesh.name = name;
    mesh.position.copy(center);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    group.add(mesh);
    return mesh;
  };

  const rodLength = rodStart.distanceTo(rodEnd);
  const damper = placeOnRod(0.38, 0.075, 0.14, materials.grip, "Stabilizer_Damper");
  damper.userData.part = "Stabilizer";

  const weight = placeOnRod(rodLength - 0.20, 0.115, 0.30, materials.sight, "Stabilizer_Weight");
  weight.userData.part = "Stabilizer";
  const endCap = placeOnRod(rodLength - 0.005, 0.055, 0.06, materials.sight, "Stabilizer_End_Cap");
  endCap.userData.part = "Stabilizer";

  return group;
}

function buildGrip(THREE, materials) {
  const group = new THREE.Group();
  group.name = "Grip";
  group.userData.part = "Grip";

  // Tapered rounded pad swept down the riser's throat. It bulges in the middle
  // of the grip and fades into the riser at both ends.
  const profile = (t) => 0.28 + 0.72 * Math.pow(Math.sin(Math.PI * t), 0.55);
  const geometry = sweptRibbonGeometry(THREE, GRIP_POINTS, {
    segments: 48,
    widthAt: (t) => GRIP_WIDTH * profile(t),
    thicknessAt: (t) => GRIP_THICKNESS * profile(t),
    roundness: 0.5,
  });
  const grip = new THREE.Mesh(geometry, materials.grip);
  grip.name = "Grip";
  group.add(grip);

  return group;
}

export function buildRecurveBowModel(THREE) {
  const materials = buildMaterials(THREE);

  const bow = new THREE.Group();
  bow.name = "Bow_Recurve";
  bow.rotation.order = "YZX";
  bow.userData.modelSource = "procedural-recurve";
  bow.userData.partNames = [...PART_NAMES];

  bow.add(buildRiser(THREE, materials));

  const topLimb = buildLimb(THREE, TOP_LIMB_POINTS, "Top_Limb", materials);
  bow.add(topLimb);

  const bottomPoints = TOP_LIMB_POINTS.map(([x, y]) => [x, -y]);
  const bottomLimb = buildLimb(THREE, bottomPoints, "Bottom_Limb", materials);
  bow.add(bottomLimb);

  bow.add(buildString(THREE, materials));
  bow.add(buildSight(THREE, materials));
  bow.add(buildStabilizer(THREE, materials));
  bow.add(buildGrip(THREE, materials));

  return bow;
}
