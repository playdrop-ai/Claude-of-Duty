import * as THREE from 'three';

// The depth and shadow passes must use the same leaf mask as the colour pass.
export function cutoutUniforms() {
  return {
    owAlphaMap: { value: null },
    owAlphaTest: { value: 0 },
    owAlphaTile: { value: new THREE.Vector4(1, 1, 0, 0) },
    owMapTransform: { value: new THREE.Matrix3() },
  };
}

export function updateCutout(uniforms, source) {
  uniforms.owAlphaTest.value = source.alphaTest;
  if (source.alphaTest > 0) {
    uniforms.owAlphaMap.value = source.map;
    if (source.map.matrixAutoUpdate) source.map.updateMatrix();
    uniforms.owMapTransform.value.copy(source.map.matrix);
    uniforms.owAlphaTile.value.copy(source.userData.owUniforms.owTile.value);
  }
}

export const CUTOUT_PARS = /* glsl */ `
  uniform sampler2D owAlphaMap;
  uniform float owAlphaTest;
  uniform vec4 owAlphaTile;
  uniform mat3 owMapTransform;
  varying vec2 vAlphaUv;
`;

export const CUTOUT_TEST = /* glsl */ `
  if (owAlphaTest > 0.0) {
    vec2 uv = (owMapTransform * vec3(vAlphaUv, 1.0)).xy;
    uv = uv * owAlphaTile.xy + owAlphaTile.zw;
    if (texture2D(owAlphaMap, uv).a < owAlphaTest) discard;
  }
`;
