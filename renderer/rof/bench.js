import * as THREE from 'three';
import { roundedRectPath, planarUV } from './trayModels.js';

// The bench: a wooden board in front of the tray (toward the camera) holding every piece that has
// not been placed yet. Pieces are dragged from here onto the tray, and back again.

const BOARD_T = 1.4;

export function createBench({ surfaces, cx, cy, width, depth }) {
  const group = new THREE.Group();
  const outline = roundedRectPath(new THREE.Shape(), width, depth, 1.4);
  const geo = new THREE.ExtrudeGeometry(outline, {
    depth: BOARD_T - 0.24, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelOffset: -0.12, bevelSegments: 3, curveSegments: 16,
  });
  planarUV(geo, 'xy', 40);
  const board = new THREE.Mesh(geo, surfaces.wood);
  board.rotation.x = -Math.PI / 2;
  board.position.set(cx, 0.12, -cy);
  board.castShadow = true; board.receiveShadow = true;
  group.add(board);
  return {
    group, top: BOARD_T,
    rect: { cx, cy, hw: width / 2 - 1.2, hh: depth / 2 - 1.2 }, // usable area, inside the board's rim
    dispose() { geo.dispose(); },
  };
}
