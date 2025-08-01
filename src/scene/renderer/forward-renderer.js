import { now } from '../../core/time.js';
import { Debug } from '../../core/debug.js';
import { Vec3 } from '../../core/math/vec3.js';
import { Color } from '../../core/math/color.js';
import { DebugGraphics } from '../../platform/graphics/debug-graphics.js';
import {
    FOG_NONE, FOG_LINEAR,
    LIGHTTYPE_OMNI, LIGHTTYPE_SPOT, LIGHTTYPE_DIRECTIONAL,
    LIGHTSHAPE_PUNCTUAL,
    LAYERID_DEPTH
} from '../constants.js';
import { WorldClustersDebug } from '../lighting/world-clusters-debug.js';
import { Renderer } from './renderer.js';
import { LightCamera } from './light-camera.js';
import { RenderPassForward } from './render-pass-forward.js';
import { RenderPassPostprocessing } from './render-pass-postprocessing.js';
import { BINDGROUP_VIEW } from '../../platform/graphics/constants.js';

/**
 * @import { BindGroup } from '../../platform/graphics/bind-group.js'
 * @import { Camera } from '../camera.js'
 * @import { FrameGraph } from '../frame-graph.js'
 * @import { GraphicsDevice } from '../../platform/graphics/graphics-device.js'
 * @import { LayerComposition } from '../composition/layer-composition.js'
 * @import { Layer } from '../layer.js'
 * @import { MeshInstance } from '../mesh-instance.js'
 * @import { RenderTarget } from '../../platform/graphics/render-target.js'
 * @import { Scene } from '../scene.js'
 * @import { WorldClusters } from '../lighting/world-clusters.js'
 */

const _noLights = [[], [], []];
const tmpColor = new Color();

const _drawCallList = {
    drawCalls: [],
    shaderInstances: [],
    isNewMaterial: [],
    lightMaskChanged: [],

    clear: function () {
        this.drawCalls.length = 0;
        this.shaderInstances.length = 0;
        this.isNewMaterial.length = 0;
        this.lightMaskChanged.length = 0;
    }
};

function vogelDiskPrecalculationSamples(numSamples) {
    const samples = [];
    for (let i = 0; i < numSamples; ++i) {
        const r = Math.sqrt(i + 0.5) / Math.sqrt(numSamples);
        samples.push(r);
    }
    return samples;
}

function vogelSpherePrecalculationSamples(numSamples) {
    const samples = [];
    for (let i = 0; i < numSamples; i++) {
        const weight = i / numSamples;
        const radius = Math.sqrt(weight * weight);
        samples.push(radius);
    }
    return samples;
}

/**
 * The forward renderer renders {@link Scene}s.
 *
 * @ignore
 */
class ForwardRenderer extends Renderer {
    /**
     * Create a new ForwardRenderer instance.
     *
     * @param {GraphicsDevice} graphicsDevice - The graphics device used by the renderer.
     */
    constructor(graphicsDevice) {
        super(graphicsDevice);

        const device = this.device;

        this._forwardDrawCalls = 0;
        this._materialSwitches = 0;
        this._depthMapTime = 0;
        this._forwardTime = 0;
        this._sortTime = 0;

        // Uniforms
        const scope = device.scope;

        this.fogColorId = scope.resolve('fog_color');
        this.fogStartId = scope.resolve('fog_start');
        this.fogEndId = scope.resolve('fog_end');
        this.fogDensityId = scope.resolve('fog_density');

        this.ambientId = scope.resolve('light_globalAmbient');
        this.skyboxIntensityId = scope.resolve('skyboxIntensity');
        this.cubeMapRotationMatrixId = scope.resolve('cubeMapRotationMatrix');
        this.pcssDiskSamplesId = scope.resolve('pcssDiskSamples[0]');
        this.pcssSphereSamplesId = scope.resolve('pcssSphereSamples[0]');
        this.lightColorId = [];
        this.lightDir = [];
        this.lightDirId = [];
        this.lightShadowMapId = [];
        this.lightShadowMatrixId = [];
        this.lightShadowParamsId = [];
        this.lightShadowIntensity = [];
        this.lightRadiusId = [];
        this.lightPos = [];
        this.lightPosId = [];
        this.lightWidth = [];
        this.lightWidthId = [];
        this.lightHeight = [];
        this.lightHeightId = [];
        this.lightInAngleId = [];
        this.lightOutAngleId = [];
        this.lightCookieId = [];
        this.lightCookieIntId = [];
        this.lightCookieMatrixId = [];
        this.lightCookieOffsetId = [];
        this.lightShadowSearchAreaId = [];
        this.lightCameraParamsId = [];
        this.lightSoftShadowParamsId = [];

        // shadow cascades
        this.shadowMatrixPaletteId = [];
        this.shadowCascadeDistancesId = [];
        this.shadowCascadeCountId = [];
        this.shadowCascadeBlendId = [];

        this.screenSizeId = scope.resolve('uScreenSize');
        this._screenSize = new Float32Array(4);

        this.fogColor = new Float32Array(3);
        this.ambientColor = new Float32Array(3);

        this.pcssDiskSamples = vogelDiskPrecalculationSamples(16);
        this.pcssSphereSamples = vogelSpherePrecalculationSamples(16);
    }

    destroy() {
        super.destroy();
    }

    // #if _PROFILER
    // Static properties used by the Profiler in the Editor's Launch Page
    static skipRenderCamera = null;

    static _skipRenderCounter = 0;

    static skipRenderAfter = 0;
    // #endif

    /**
     * @param {Scene} scene - The scene.
     */
    dispatchGlobalLights(scene) {
        const ambientUniform = this.ambientColor;

        // color in linear space
        tmpColor.linear(scene.ambientLight);
        ambientUniform[0] = tmpColor.r;
        ambientUniform[1] = tmpColor.g;
        ambientUniform[2] = tmpColor.b;

        if (scene.physicalUnits) {
            for (let i = 0; i < 3; i++) {
                ambientUniform[i] *= scene.ambientLuminance;
            }
        }
        this.ambientId.setValue(ambientUniform);

        this.skyboxIntensityId.setValue(scene.physicalUnits ? scene.skyboxLuminance : scene.skyboxIntensity);
        this.cubeMapRotationMatrixId.setValue(scene._skyboxRotationMat3.data);
    }

    _resolveLight(scope, i) {
        const light = `light${i}`;
        this.lightColorId[i] = scope.resolve(`${light}_color`);
        this.lightDir[i] = new Float32Array(3);
        this.lightDirId[i] = scope.resolve(`${light}_direction`);
        this.lightShadowMapId[i] = scope.resolve(`${light}_shadowMap`);
        this.lightShadowMatrixId[i] = scope.resolve(`${light}_shadowMatrix`);
        this.lightShadowParamsId[i] = scope.resolve(`${light}_shadowParams`);
        this.lightShadowIntensity[i] = scope.resolve(`${light}_shadowIntensity`);
        this.lightShadowSearchAreaId[i] = scope.resolve(`${light}_shadowSearchArea`);
        this.lightRadiusId[i] = scope.resolve(`${light}_radius`);
        this.lightPos[i] = new Float32Array(3);
        this.lightPosId[i] = scope.resolve(`${light}_position`);
        this.lightWidth[i] = new Float32Array(3);
        this.lightWidthId[i] = scope.resolve(`${light}_halfWidth`);
        this.lightHeight[i] = new Float32Array(3);
        this.lightHeightId[i] = scope.resolve(`${light}_halfHeight`);
        this.lightInAngleId[i] = scope.resolve(`${light}_innerConeAngle`);
        this.lightOutAngleId[i] = scope.resolve(`${light}_outerConeAngle`);
        this.lightCookieId[i] = scope.resolve(`${light}_cookie`);
        this.lightCookieIntId[i] = scope.resolve(`${light}_cookieIntensity`);
        this.lightCookieMatrixId[i] = scope.resolve(`${light}_cookieMatrix`);
        this.lightCookieOffsetId[i] = scope.resolve(`${light}_cookieOffset`);
        this.lightCameraParamsId[i] = scope.resolve(`${light}_cameraParams`);
        this.lightSoftShadowParamsId[i] = scope.resolve(`${light}_softShadowParams`);

        // shadow cascades
        this.shadowMatrixPaletteId[i] = scope.resolve(`${light}_shadowMatrixPalette[0]`);
        this.shadowCascadeDistancesId[i] = scope.resolve(`${light}_shadowCascadeDistances`);
        this.shadowCascadeCountId[i] = scope.resolve(`${light}_shadowCascadeCount`);
        this.shadowCascadeBlendId[i] = scope.resolve(`${light}_shadowCascadeBlend`);
    }

    setLTCDirectionalLight(wtm, cnt, dir, campos, far) {
        this.lightPos[cnt][0] = campos.x - dir.x * far;
        this.lightPos[cnt][1] = campos.y - dir.y * far;
        this.lightPos[cnt][2] = campos.z - dir.z * far;
        this.lightPosId[cnt].setValue(this.lightPos[cnt]);

        const hWidth = wtm.transformVector(new Vec3(-0.5, 0, 0));
        this.lightWidth[cnt][0] = hWidth.x * far;
        this.lightWidth[cnt][1] = hWidth.y * far;
        this.lightWidth[cnt][2] = hWidth.z * far;
        this.lightWidthId[cnt].setValue(this.lightWidth[cnt]);

        const hHeight = wtm.transformVector(new Vec3(0, 0, 0.5));
        this.lightHeight[cnt][0] = hHeight.x * far;
        this.lightHeight[cnt][1] = hHeight.y * far;
        this.lightHeight[cnt][2] = hHeight.z * far;
        this.lightHeightId[cnt].setValue(this.lightHeight[cnt]);
    }

    dispatchDirectLights(dirs, mask, camera) {
        let cnt = 0;

        const scope = this.device.scope;

        for (let i = 0; i < dirs.length; i++) {
            if (!(dirs[i].mask & mask)) continue;

            const directional = dirs[i];
            const wtm = directional._node.getWorldTransform();

            if (!this.lightColorId[cnt]) {
                this._resolveLight(scope, cnt);
            }

            this.lightColorId[cnt].setValue(directional._colorLinear);

            // Directional lights shine down the negative Y axis
            wtm.getY(directional._direction).mulScalar(-1);
            directional._direction.normalize();
            this.lightDir[cnt][0] = directional._direction.x;
            this.lightDir[cnt][1] = directional._direction.y;
            this.lightDir[cnt][2] = directional._direction.z;
            this.lightDirId[cnt].setValue(this.lightDir[cnt]);

            if (directional.shape !== LIGHTSHAPE_PUNCTUAL) {
                // non-punctual shape - NB directional area light specular is approximated by putting the area light at the far clip
                this.setLTCDirectionalLight(wtm, cnt, directional._direction, camera._node.getPosition(), camera.farClip);
            }

            if (directional.castShadows) {

                const lightRenderData = directional.getRenderData(camera, 0);
                const biases = directional._getUniformBiasValues(lightRenderData);

                this.lightShadowMapId[cnt].setValue(lightRenderData.shadowBuffer);
                this.lightShadowMatrixId[cnt].setValue(lightRenderData.shadowMatrix.data);

                this.shadowMatrixPaletteId[cnt].setValue(directional._shadowMatrixPalette);
                this.shadowCascadeDistancesId[cnt].setValue(directional._shadowCascadeDistances);
                this.shadowCascadeCountId[cnt].setValue(directional.numCascades);
                this.shadowCascadeBlendId[cnt].setValue(1 - directional.cascadeBlend);
                this.lightShadowIntensity[cnt].setValue(directional.shadowIntensity);
                this.lightSoftShadowParamsId[cnt].setValue(directional._softShadowParams);

                const shadowRT = lightRenderData.shadowCamera.renderTarget;
                if (shadowRT) {
                    this.lightShadowSearchAreaId[cnt].setValue(directional.penumbraSize / lightRenderData.shadowCamera.renderTarget.width * lightRenderData.projectionCompensation);
                }

                const cameraParams = directional._shadowCameraParams;
                cameraParams.length = 4;
                cameraParams[0] = 0; // unused
                cameraParams[1] = lightRenderData.shadowCamera._farClip;
                cameraParams[2] = lightRenderData.shadowCamera._nearClip;
                cameraParams[3] = 1;
                this.lightCameraParamsId[cnt].setValue(cameraParams);

                const params = directional._shadowRenderParams;
                params.length = 4;
                params[0] = directional._shadowResolution;  // Note: this needs to change for non-square shadow maps (2 cascades). Currently square is used
                params[1] = biases.normalBias;
                params[2] = biases.bias;
                params[3] = 0;
                this.lightShadowParamsId[cnt].setValue(params);
            }
            cnt++;
        }
        return cnt;
    }

    setLTCPositionalLight(wtm, cnt) {
        const hWidth = wtm.transformVector(new Vec3(-0.5, 0, 0));
        this.lightWidth[cnt][0] = hWidth.x;
        this.lightWidth[cnt][1] = hWidth.y;
        this.lightWidth[cnt][2] = hWidth.z;
        this.lightWidthId[cnt].setValue(this.lightWidth[cnt]);

        const hHeight = wtm.transformVector(new Vec3(0, 0, 0.5));
        this.lightHeight[cnt][0] = hHeight.x;
        this.lightHeight[cnt][1] = hHeight.y;
        this.lightHeight[cnt][2] = hHeight.z;
        this.lightHeightId[cnt].setValue(this.lightHeight[cnt]);
    }

    dispatchOmniLight(scope, omni, cnt) {
        const wtm = omni._node.getWorldTransform();

        if (!this.lightColorId[cnt]) {
            this._resolveLight(scope, cnt);
        }

        this.lightRadiusId[cnt].setValue(omni.attenuationEnd);
        this.lightColorId[cnt].setValue(omni._colorLinear);
        wtm.getTranslation(omni._position);
        this.lightPos[cnt][0] = omni._position.x;
        this.lightPos[cnt][1] = omni._position.y;
        this.lightPos[cnt][2] = omni._position.z;
        this.lightPosId[cnt].setValue(this.lightPos[cnt]);

        if (omni.shape !== LIGHTSHAPE_PUNCTUAL) {
            // non-punctual shape
            this.setLTCPositionalLight(wtm, cnt);
        }

        if (omni.castShadows) {

            // shadow map
            const lightRenderData = omni.getRenderData(null, 0);
            this.lightShadowMapId[cnt].setValue(lightRenderData.shadowBuffer);

            const biases = omni._getUniformBiasValues(lightRenderData);
            const params = omni._shadowRenderParams;
            params.length = 4;
            params[0] = omni._shadowResolution;
            params[1] = biases.normalBias;
            params[2] = biases.bias;
            params[3] = 1.0 / omni.attenuationEnd;
            this.lightShadowParamsId[cnt].setValue(params);
            this.lightShadowIntensity[cnt].setValue(omni.shadowIntensity);

            const pixelsPerMeter = omni.penumbraSize / lightRenderData.shadowCamera.renderTarget.width;
            this.lightShadowSearchAreaId[cnt].setValue(pixelsPerMeter);
            const cameraParams = omni._shadowCameraParams;

            cameraParams.length = 4;
            cameraParams[0] = 0; // unused
            cameraParams[1] = lightRenderData.shadowCamera._farClip;
            cameraParams[2] = lightRenderData.shadowCamera._nearClip;
            cameraParams[3] = 0;
            this.lightCameraParamsId[cnt].setValue(cameraParams);
        }
        if (omni._cookie) {
            this.lightCookieId[cnt].setValue(omni._cookie);
            this.lightShadowMatrixId[cnt].setValue(wtm.data);
            this.lightCookieIntId[cnt].setValue(omni.cookieIntensity);
        }
    }

    dispatchSpotLight(scope, spot, cnt) {
        const wtm = spot._node.getWorldTransform();

        if (!this.lightColorId[cnt]) {
            this._resolveLight(scope, cnt);
        }

        this.lightInAngleId[cnt].setValue(spot._innerConeAngleCos);
        this.lightOutAngleId[cnt].setValue(spot._outerConeAngleCos);
        this.lightRadiusId[cnt].setValue(spot.attenuationEnd);
        this.lightColorId[cnt].setValue(spot._colorLinear);
        wtm.getTranslation(spot._position);
        this.lightPos[cnt][0] = spot._position.x;
        this.lightPos[cnt][1] = spot._position.y;
        this.lightPos[cnt][2] = spot._position.z;
        this.lightPosId[cnt].setValue(this.lightPos[cnt]);

        if (spot.shape !== LIGHTSHAPE_PUNCTUAL) {
            // non-punctual shape
            this.setLTCPositionalLight(wtm, cnt);
        }

        // Spots shine down the negative Y axis
        wtm.getY(spot._direction).mulScalar(-1);
        spot._direction.normalize();
        this.lightDir[cnt][0] = spot._direction.x;
        this.lightDir[cnt][1] = spot._direction.y;
        this.lightDir[cnt][2] = spot._direction.z;
        this.lightDirId[cnt].setValue(this.lightDir[cnt]);

        if (spot.castShadows) {

            // shadow map
            const lightRenderData = spot.getRenderData(null, 0);
            this.lightShadowMapId[cnt].setValue(lightRenderData.shadowBuffer);

            this.lightShadowMatrixId[cnt].setValue(lightRenderData.shadowMatrix.data);

            const biases = spot._getUniformBiasValues(lightRenderData);
            const params = spot._shadowRenderParams;
            params.length = 4;
            params[0] = spot._shadowResolution;
            params[1] = biases.normalBias;
            params[2] = biases.bias;
            params[3] = 1.0 / spot.attenuationEnd;
            this.lightShadowParamsId[cnt].setValue(params);
            this.lightShadowIntensity[cnt].setValue(spot.shadowIntensity);

            const pixelsPerMeter = spot.penumbraSize / lightRenderData.shadowCamera.renderTarget.width;
            const fov = lightRenderData.shadowCamera._fov * Math.PI / 180.0;
            const fovRatio = 1.0 / Math.tan(fov / 2.0);
            this.lightShadowSearchAreaId[cnt].setValue(pixelsPerMeter * fovRatio);

            const cameraParams = spot._shadowCameraParams;
            cameraParams.length = 4;
            cameraParams[0] = 0; // unused
            cameraParams[1] = lightRenderData.shadowCamera._farClip;
            cameraParams[2] = lightRenderData.shadowCamera._nearClip;
            cameraParams[3] = 0;
            this.lightCameraParamsId[cnt].setValue(cameraParams);
        }

        if (spot._cookie) {

            // if shadow is not rendered, we need to evaluate light projection matrix
            if (!spot.castShadows) {
                const cookieMatrix = LightCamera.evalSpotCookieMatrix(spot);
                this.lightShadowMatrixId[cnt].setValue(cookieMatrix.data);
            }

            this.lightCookieId[cnt].setValue(spot._cookie);
            this.lightCookieIntId[cnt].setValue(spot.cookieIntensity);
            if (spot._cookieTransform) {
                spot._cookieTransformUniform[0] = spot._cookieTransform.x;
                spot._cookieTransformUniform[1] = spot._cookieTransform.y;
                spot._cookieTransformUniform[2] = spot._cookieTransform.z;
                spot._cookieTransformUniform[3] = spot._cookieTransform.w;
                this.lightCookieMatrixId[cnt].setValue(spot._cookieTransformUniform);
                spot._cookieOffsetUniform[0] = spot._cookieOffset.x;
                spot._cookieOffsetUniform[1] = spot._cookieOffset.y;
                this.lightCookieOffsetId[cnt].setValue(spot._cookieOffsetUniform);
            }
        }
    }

    dispatchLocalLights(sortedLights, mask, usedDirLights) {

        let cnt = usedDirLights;
        const scope = this.device.scope;

        const omnis = sortedLights[LIGHTTYPE_OMNI];
        const numOmnis = omnis.length;
        for (let i = 0; i < numOmnis; i++) {
            const omni = omnis[i];
            if (!(omni.mask & mask)) continue;
            this.dispatchOmniLight(scope, omni, cnt);
            cnt++;
        }

        const spts = sortedLights[LIGHTTYPE_SPOT];
        const numSpts = spts.length;
        for (let i = 0; i < numSpts; i++) {
            const spot = spts[i];
            if (!(spot.mask & mask)) continue;
            this.dispatchSpotLight(scope, spot, cnt);
            cnt++;
        }
    }

    // execute first pass over draw calls, in order to update materials / shaders
    renderForwardPrepareMaterials(camera, renderTarget, drawCalls, sortedLights, layer, pass) {

        // fog params from the scene, or overridden by the camera
        const fogParams = camera.fogParams ?? this.scene.fog;

        // camera shader params
        const shaderParams = camera.shaderParams;
        shaderParams.fog = fogParams.type;
        shaderParams.srgbRenderTarget = renderTarget?.isColorBufferSrgb(0) ?? false;    // output gamma correction is determined by the render target

        const addCall = (drawCall, shaderInstance, isNewMaterial, lightMaskChanged) => {
            _drawCallList.drawCalls.push(drawCall);
            _drawCallList.shaderInstances.push(shaderInstance);
            _drawCallList.isNewMaterial.push(isNewMaterial);
            _drawCallList.lightMaskChanged.push(lightMaskChanged);
        };

        // start with empty arrays
        _drawCallList.clear();

        const device = this.device;
        const scene = this.scene;
        const clusteredLightingEnabled = scene.clusteredLightingEnabled;
        const lightHash = layer?.getLightHash(clusteredLightingEnabled) ?? 0;
        let prevMaterial = null, prevObjDefs, prevLightMask;

        const drawCallsCount = drawCalls.length;
        for (let i = 0; i < drawCallsCount; i++) {

            /** @type {MeshInstance} */
            const drawCall = drawCalls[i];

            // #if _PROFILER
            if (camera === ForwardRenderer.skipRenderCamera) {
                if (ForwardRenderer._skipRenderCounter >= ForwardRenderer.skipRenderAfter) {
                    continue;
                }
                ForwardRenderer._skipRenderCounter++;
            }
            if (layer) {
                if (layer._skipRenderCounter >= layer.skipRenderAfter) {
                    continue;
                }
                layer._skipRenderCounter++;
            }
            // #endif

            // skip instanced rendering with 0 instances
            const instancingData = drawCall.instancingData;
            if (instancingData && instancingData.count <= 0) {
                continue;
            }

            drawCall.ensureMaterial(device);
            const material = drawCall.material;

            const objDefs = drawCall._shaderDefs;
            const lightMask = drawCall.mask;

            if (material && material === prevMaterial && objDefs !== prevObjDefs) {
                prevMaterial = null; // force change shader if the object uses a different variant of the same material
            }

            if (material !== prevMaterial) {
                this._materialSwitches++;
                material._scene = scene;

                if (material.dirty) {
                    DebugGraphics.pushGpuMarker(device, `Node: ${drawCall.node.name}, Material: ${material.name}`);
                    material.updateUniforms(device, scene);
                    material.dirty = false;
                    DebugGraphics.popGpuMarker(device);
                }
            }

            const shaderInstance = drawCall.getShaderInstance(pass, lightHash, scene, shaderParams, this.viewUniformFormat, this.viewBindGroupFormat, sortedLights);

            addCall(drawCall, shaderInstance, material !== prevMaterial, !prevMaterial || lightMask !== prevLightMask);

            prevMaterial = material;
            prevObjDefs = objDefs;
            prevLightMask = lightMask;
        }

        return _drawCallList;
    }

    renderForwardInternal(camera, preparedCalls, sortedLights, pass, drawCallback, flipFaces, viewBindGroups) {
        const device = this.device;
        const scene = this.scene;
        const passFlag = 1 << pass;
        const flipFactor = flipFaces ? -1 : 1;
        const clusteredLightingEnabled = scene.clusteredLightingEnabled;

        // multiview xr rendering
        const viewList = camera.xr?.session && camera.xr.views.list.length ? camera.xr.views.list : null;

        // Render the scene
        const preparedCallsCount = preparedCalls.drawCalls.length;
        for (let i = 0; i < preparedCallsCount; i++) {

            const drawCall = preparedCalls.drawCalls[i];

            // We have a mesh instance
            const newMaterial = preparedCalls.isNewMaterial[i];
            const lightMaskChanged = preparedCalls.lightMaskChanged[i];
            const shaderInstance = preparedCalls.shaderInstances[i];
            const material = drawCall.material;
            const lightMask = drawCall.mask;

            if (shaderInstance.shader.failed) continue;

            if (newMaterial) {

                const asyncCompile = false;
                device.setShader(shaderInstance.shader, asyncCompile);

                // Uniforms I: material
                material.setParameters(device);

                if (lightMaskChanged) {
                    const usedDirLights = this.dispatchDirectLights(sortedLights[LIGHTTYPE_DIRECTIONAL], lightMask, camera);

                    if (!clusteredLightingEnabled) {
                        this.dispatchLocalLights(sortedLights, lightMask, usedDirLights);
                    }
                }

                this.alphaTestId.setValue(material.alphaTest);

                device.setBlendState(material.blendState);
                device.setDepthState(material.depthState);
                device.setAlphaToCoverage(material.alphaToCoverage);
            }

            DebugGraphics.pushGpuMarker(device, `Node: ${drawCall.node.name}, Material: ${material.name}`);

            this.setupCullMode(camera._cullFaces, flipFactor, drawCall);

            const stencilFront = drawCall.stencilFront ?? material.stencilFront;
            const stencilBack = drawCall.stencilBack ?? material.stencilBack;
            device.setStencilState(stencilFront, stencilBack);

            // Uniforms II: meshInstance overrides
            drawCall.setParameters(device, passFlag);

            // mesh ID - used by the picker
            device.scope.resolve('meshInstanceId').setValue(drawCall.id);

            const mesh = drawCall.mesh;
            this.setVertexBuffers(device, mesh);
            this.setMorphing(device, drawCall.morphInstance);
            this.setSkinning(device, drawCall);

            const instancingData = drawCall.instancingData;
            if (instancingData) {
                device.setVertexBuffer(instancingData.vertexBuffer);
            }

            // mesh / mesh normal matrix
            this.setMeshInstanceMatrices(drawCall, true);

            this.setupMeshUniformBuffers(shaderInstance);

            const style = drawCall.renderStyle;
            const indexBuffer = mesh.indexBuffer[style];

            drawCallback?.(drawCall, i);

            const indirectSlot = drawCall.indirectData?.get(camera);

            if (viewList) {
                for (let v = 0; v < viewList.length; v++) {
                    const view = viewList[v];

                    device.setViewport(view.viewport.x, view.viewport.y, view.viewport.z, view.viewport.w);

                    if (device.supportsUniformBuffers) {

                        const viewBindGroup = viewBindGroups[v];
                        device.setBindGroup(BINDGROUP_VIEW, viewBindGroup);

                    } else {

                        this.setupViewUniforms(view, v);
                    }

                    const first = v === 0;
                    const last = v === viewList.length - 1;
                    device.draw(mesh.primitive[style], indexBuffer, instancingData?.count, indirectSlot, first, last);

                    this._forwardDrawCalls++;
                    if (drawCall.instancingData) {
                        this._instancedDrawCalls++;
                    }
                }
            } else {
                device.draw(mesh.primitive[style], indexBuffer, instancingData?.count, indirectSlot);

                this._forwardDrawCalls++;
                if (drawCall.instancingData) {
                    this._instancedDrawCalls++;
                }
            }

            // Unset meshInstance overrides back to material values if next draw call will use the same material
            if (i < preparedCallsCount - 1 && !preparedCalls.isNewMaterial[i + 1]) {
                material.setParameters(device, drawCall.parameters);
            }

            DebugGraphics.popGpuMarker(device);
        }
    }

    renderForward(camera, renderTarget, allDrawCalls, sortedLights, pass, drawCallback, layer, flipFaces, viewBindGroups) {

        // #if _PROFILER
        const forwardStartTime = now();
        // #endif

        // run first pass over draw calls and handle material / shader updates
        const preparedCalls = this.renderForwardPrepareMaterials(camera, renderTarget, allDrawCalls, sortedLights, layer, pass);

        // render mesh instances
        this.renderForwardInternal(camera, preparedCalls, sortedLights, pass, drawCallback, flipFaces, viewBindGroups);

        _drawCallList.clear();

        // #if _PROFILER
        this._forwardTime += now() - forwardStartTime;
        // #endif
    }

    /**
     * Forward render mesh instances on a specified layer, using a camera and a render target.
     * Shaders used are based on the shaderPass provided, with optional clustered lighting support.
     *
     * @param {Camera} camera - The camera.
     * @param {RenderTarget|undefined} renderTarget - The render target.
     * @param {Layer} layer - The layer.
     * @param {boolean} transparent - True if transparent sublayer should be rendered, opaque
     * otherwise.
     * @param {number} shaderPass - A type of shader to use during rendering.
     * @param {BindGroup[]} viewBindGroups - An array storing the view level bing groups (can be
     * empty array, and this function populates if per view).
     * @param {object} [options] - Object for passing optional arguments.
     * @param {boolean} [options.clearColor] - True if the color buffer should be cleared.
     * @param {boolean} [options.clearDepth] - True if the depth buffer should be cleared.
     * @param {boolean} [options.clearStencil] - True if the stencil buffer should be cleared.
     * @param {WorldClusters} [options.lightClusters] - The world clusters object to be used for
     * clustered lighting.
     * @param {MeshInstance[]} [options.meshInstances] - The mesh instances to be rendered. Use
     * when layer is not provided.
     * @param {object} [options.splitLights] - The split lights to be used for clustered lighting.
     */
    renderForwardLayer(camera, renderTarget, layer, transparent, shaderPass, viewBindGroups, options = {}) {

        const { scene, device } = this;
        const clusteredLightingEnabled = scene.clusteredLightingEnabled;

        this.setupViewport(camera, renderTarget);

        let visible, splitLights;
        if (layer) {
            // #if _PROFILER
            const sortTime = now();
            // #endif

            layer.sortVisible(camera, transparent);

            // #if _PROFILER
            this._sortTime += now() - sortTime;
            // #endif

            const culledInstances = layer.getCulledInstances(camera);
            visible = transparent ? culledInstances.transparent : culledInstances.opaque;

            // add debug mesh instances to visible list
            scene.immediate.onPreRenderLayer(layer, visible, transparent);

            // set up layer uniforms
            if (layer.requiresLightCube) {
                this.lightCube.update(scene.ambientLight, layer._lights);
                this.constantLightCube.setValue(this.lightCube.colors);
            }

            splitLights = layer.splitLights;

        } else {
            visible = options.meshInstances;
            splitLights = options.splitLights ?? _noLights;
        }

        Debug.assert(visible, 'Either layer or options.meshInstances must be provided');

        // upload clustered lights uniforms
        if (clusteredLightingEnabled) {
            const lightClusters = options.lightClusters ?? this.worldClustersAllocator.empty;
            lightClusters.activate();

            // debug rendering of clusters
            if (layer) {
                if (!this.clustersDebugRendered && scene.lighting.debugLayer === layer.id) {
                    this.clustersDebugRendered = true;
                    WorldClustersDebug.render(lightClusters, this.scene);
                }
            }
        }

        // Set the not very clever global variable which is only useful when there's just one camera
        scene._activeCamera = camera;

        const fogParams = camera.fogParams ?? this.scene.fog;
        this.setFogConstants(fogParams);

        const viewList = this.setCameraUniforms(camera, renderTarget);
        if (device.supportsUniformBuffers) {
            this.setupViewUniformBuffers(viewBindGroups, this.viewUniformFormat, this.viewBindGroupFormat, viewList);
        }

        // clearing - do it after the view bind groups are set up, to avoid overriding those
        const clearColor = options.clearColor ?? false;
        const clearDepth = options.clearDepth ?? false;
        const clearStencil = options.clearStencil ?? false;
        if (clearColor || clearDepth || clearStencil) {
            this.clear(camera, clearColor, clearDepth, clearStencil);
        }

        // enable flip faces if either the camera has _flipFaces enabled or the render target has flipY enabled
        const flipFaces = !!(camera._flipFaces ^ renderTarget?.flipY);

        const forwardDrawCalls = this._forwardDrawCalls;
        this.renderForward(camera,
            renderTarget,
            visible,
            splitLights,
            shaderPass,
            null,
            layer,
            flipFaces,
            viewBindGroups);

        if (layer) {
            layer._forwardDrawCalls += this._forwardDrawCalls - forwardDrawCalls;
        }
    }

    setFogConstants(fogParams) {

        if (fogParams.type !== FOG_NONE) {

            // color in linear space
            tmpColor.linear(fogParams.color);
            const fogUniform = this.fogColor;
            fogUniform[0] = tmpColor.r;
            fogUniform[1] = tmpColor.g;
            fogUniform[2] = tmpColor.b;
            this.fogColorId.setValue(fogUniform);

            if (fogParams.type === FOG_LINEAR) {
                this.fogStartId.setValue(fogParams.start);
                this.fogEndId.setValue(fogParams.end);
            } else {
                this.fogDensityId.setValue(fogParams.density);
            }
        }
    }

    setSceneConstants() {
        const scene = this.scene;

        // Set up ambient/exposure
        this.dispatchGlobalLights(scene);

        // Set up screen size // should be RT size?
        const device = this.device;
        this._screenSize[0] = device.width;
        this._screenSize[1] = device.height;
        this._screenSize[2] = 1 / device.width;
        this._screenSize[3] = 1 / device.height;
        this.screenSizeId.setValue(this._screenSize);

        this.pcssDiskSamplesId.setValue(this.pcssDiskSamples);
        this.pcssSphereSamplesId.setValue(this.pcssSphereSamples);
    }

    /**
     * Builds a frame graph for the rendering of the whole frame.
     *
     * @param {FrameGraph} frameGraph - The frame-graph that is built.
     * @param {LayerComposition} layerComposition - The layer composition used to build the frame
     * graph.
     * @ignore
     */
    buildFrameGraph(frameGraph, layerComposition) {

        const scene = this.scene;
        frameGraph.reset();

        if (scene.clusteredLightingEnabled) {

            // clustered lighting passes
            const { shadowsEnabled, cookiesEnabled } = scene.lighting;
            this._renderPassUpdateClustered.update(frameGraph, shadowsEnabled, cookiesEnabled, this.lights, this.localLights);
            frameGraph.addRenderPass(this._renderPassUpdateClustered);

        } else {

            // non-clustered local shadows - these are shared by all cameras (not entirely correctly)
            this._shadowRendererLocal.buildNonClusteredRenderPasses(frameGraph, this.localLights);
        }

        // main passes
        let startIndex = 0;
        let newStart = true;
        let renderTarget = null;
        const renderActions = layerComposition._renderActions;

        for (let i = startIndex; i < renderActions.length; i++) {

            const renderAction = renderActions[i];
            const { layer, camera } = renderAction;

            if (renderAction.useCameraPasses)  {

                Debug.call(() => {
                    if (camera.postEffects.effects.length > 0) {
                        Debug.warnOnce(`Camera '${camera.entity.name}' uses render passes, which are not compatible with post-effects scripts. Rendering of the post-effects is ignored, but they should not be attached to the camera.`);
                    }
                });

                // schedule render passes from the camera
                camera.camera.renderPasses.forEach((renderPass) => {
                    frameGraph.addRenderPass(renderPass);
                });

            } else {

                const isDepthLayer = layer.id === LAYERID_DEPTH;
                const isGrabPass = isDepthLayer && (camera.renderSceneColorMap || camera.renderSceneDepthMap);

                // start of block of render actions rendering to the same render target
                if (newStart) {
                    newStart = false;
                    startIndex = i;
                    renderTarget = renderAction.renderTarget;
                }

                // info about the next render action
                const nextRenderAction = renderActions[i + 1];
                const isNextLayerDepth = nextRenderAction ? (!nextRenderAction.useCameraPasses && nextRenderAction.layer.id === LAYERID_DEPTH) : false;
                const isNextLayerGrabPass = isNextLayerDepth && (camera.renderSceneColorMap || camera.renderSceneDepthMap);
                const nextNeedDirShadows = nextRenderAction ? (nextRenderAction.firstCameraUse && this.cameraDirShadowLights.has(nextRenderAction.camera.camera)) : false;

                // end of the block using the same render target if the next render action uses a different render target, or needs directional shadows
                // rendered before it or similar or needs other pass before it.
                if (!nextRenderAction || nextRenderAction.renderTarget !== renderTarget ||
                    nextNeedDirShadows || isNextLayerGrabPass || isGrabPass) {

                    // render the render actions in the range
                    const isDepthOnly = isDepthLayer && startIndex === i;
                    if (!isDepthOnly) {
                        this.addMainRenderPass(frameGraph, layerComposition, renderTarget, startIndex, i);
                    }

                    // depth layer triggers grab passes if enabled
                    if (isDepthLayer) {

                        if (camera.renderSceneColorMap) {
                            const colorGrabPass = camera.camera.renderPassColorGrab;
                            colorGrabPass.source = camera.renderTarget;
                            frameGraph.addRenderPass(colorGrabPass);
                        }

                        if (camera.renderSceneDepthMap) {
                            frameGraph.addRenderPass(camera.camera.renderPassDepthGrab);
                        }
                    }

                    // postprocessing
                    if (renderAction.triggerPostprocess && camera?.onPostprocessing) {
                        const renderPass = new RenderPassPostprocessing(this.device, this, renderAction);
                        frameGraph.addRenderPass(renderPass);
                    }

                    newStart = true;
                }
            }
        }
    }

    /**
     * @param {FrameGraph} frameGraph - The frame graph.
     * @param {LayerComposition} layerComposition - The layer composition.
     */
    addMainRenderPass(frameGraph, layerComposition, renderTarget, startIndex, endIndex) {

        const renderPass = new RenderPassForward(this.device, layerComposition, this.scene, this);
        renderPass.init(renderTarget);

        const renderActions = layerComposition._renderActions;
        for (let i = startIndex; i <= endIndex; i++) {
            renderPass.addRenderAction(renderActions[i]);
        }

        frameGraph.addRenderPass(renderPass);
    }

    /**
     * @param {LayerComposition} comp - The layer composition.
     */
    update(comp) {

        this.frameUpdate();
        this.shadowRenderer.frameUpdate();

        // update the skybox, since this might change _meshInstances
        this.scene._updateSkyMesh();

        // update layer composition
        this.updateLayerComposition(comp);

        this.collectLights(comp);

        // Single per-frame calculations
        this.beginFrame(comp);
        this.setSceneConstants();

        // update gsplat director
        this.gsplatDirector.update(comp);

        // visibility culling of lights, meshInstances, shadows casters
        // after this the scene culling is done and script callbacks can be called to report which objects are visible
        this.cullComposition(comp);

        // GPU update for visible objects requiring one
        this.gpuUpdate(this.processingMeshInstances);
    }
}

export { ForwardRenderer };
