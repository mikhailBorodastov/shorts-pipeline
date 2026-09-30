// Loads three.js (ES module) and the postprocessing UMD build, then resolves window.THREE_READY.
// index.html / review.html: <script>window.THREE_READY = new Promise(r => (window.__3dok = r));</script>
//                           <script type="module" src="vendor/boot3d.js"></script>
// Also: vendor/reflector.js (planar mirror) and the glTF loader (GLTFLoader.js + SkeletonUtils.js, for w.model) — optional:
// a project copied before they existed still boots.
import * as THREE from './three.module.js';
window.THREE = THREE;
const gltf = Promise.all([import('./GLTFLoader.js'), import('./SkeletonUtils.js')])
  .then(([g, s]) => { window.GLTFLoader = g.GLTFLoader; window.SkeletonUtils = s; })
  .catch(() => {});
const s = document.createElement('script');
s.src = 'vendor/postprocessing.min.js';
s.onload = () => { window.PP = window.POSTPROCESSING;
  const r = document.createElement('script'); r.src = 'vendor/reflector.js';          // planar mirror (examples/jsm)
  r.onload = r.onerror = () => gltf.then(() => window.__3dok(true)); document.head.appendChild(r); };
s.onerror = () => { console.error('postprocessing failed to load'); window.__3dok(false); };
document.head.appendChild(s);
