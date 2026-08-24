import * as THREE from "three";

export function createPreviewEnvironment() {
  const group = new THREE.Group();
  group.name = "preview-environment";

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(5, 64),
    new THREE.MeshBasicMaterial({
      color: 0x16211f,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const grid = new THREE.GridHelper(10, 20, 0x40544d, 0x26342f);
  grid.position.y = 0.003;
  grid.material.transparent = true;
  grid.material.opacity = 0.38;
  group.add(grid);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(1.9, 1.91, 96),
    new THREE.MeshBasicMaterial({
      color: 0x80e4a7,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
    }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.006;
  group.add(halo);
  return group;
}
