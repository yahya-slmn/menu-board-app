Vendored from three@0.160.0 (node_modules/three/examples/jsm/), MIT licensed -- see LICENSE.

Why copied instead of imported from node_modules: electron-builder silently drops every
`examples/` directory inside node_modules from the packaged app, so an import map pointing at
node_modules/three/examples/jsm works in `npm start` and fails in the built .app. Keep this in step
with the pinned three version in package.json; only the addons the Recipe on Fire game imports are here.
