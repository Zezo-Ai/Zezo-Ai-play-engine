import { Debug } from '../core/debug.js';
import { BLENDEQUATION_ADD, BLENDMODE_ONE, SEMANTIC_POSITION, SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL } from '../platform/graphics/constants.js';
import { drawQuadWithShader } from './graphics/quad-render-utils.js';
import { RenderTarget } from '../platform/graphics/render-target.js';
import { DebugGraphics } from '../platform/graphics/debug-graphics.js';
import { createShaderFromCode } from './shader-lib/utils.js';
import { BlendState } from '../platform/graphics/blend-state.js';
import { shaderChunks } from './shader-lib/chunks/chunks.js';
import { shaderChunksWGSL } from './shader-lib/chunks-wgsl/chunks-wgsl.js';

/**
 * @import { Morph } from './morph.js'
 * @import { Shader } from '../platform/graphics/shader.js'
 */

const blendStateAdditive = new BlendState(true, BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE);

/**
 * An instance of {@link Morph}. Contains weights to assign to every {@link MorphTarget}, manages
 * selection of active morph targets.
 *
 * @category Graphics
 */
class MorphInstance {
    /** @private */
    shaderCache = [];

    /**
     * Create a new MorphInstance instance.
     *
     * @param {Morph} morph - The {@link Morph} to instance.
     */
    constructor(morph) {
        /**
         * The morph with its targets, which is being instanced.
         *
         * @type {Morph}
         */
        this.morph = morph;
        morph.incRefCount();
        this.device = morph.device;

        // weights
        this._weights = [];
        this._weightMap = new Map();
        for (let v = 0; v < morph._targets.length; v++) {
            const target = morph._targets[v];
            if (target.name) {
                this._weightMap.set(target.name, v);
            }
            this.setWeight(v, target.defaultWeight);
        }

        // temporary array of targets with non-zero weight
        this._activeTargets = [];

        // max number of morph targets rendered at a time (each uses single texture slot)
        this.maxSubmitCount = this.device.maxTextures;

        // array for max number of weights
        this._shaderMorphWeights = new Float32Array(this.maxSubmitCount);

        // create render targets to morph targets into
        const createRT = (name, textureVar) => {

            // render to appropriate, RGBA formats, we cannot render to RGB float / half float format in WEbGL
            this[textureVar] = morph._createTexture(name, morph._renderTextureFormat);
            return new RenderTarget({
                colorBuffer: this[textureVar],
                depth: false
            });
        };

        if (morph.morphPositions) {
            this.rtPositions = createRT('MorphRTPos', 'texturePositions');
        }

        if (morph.morphNormals) {
            this.rtNormals = createRT('MorphRTNrm', 'textureNormals');
        }

        // texture params
        this._textureParams = new Float32Array([morph.morphTextureWidth, morph.morphTextureHeight]);

        // position aabb data - expand it 2x on each side to handle the expected worse range. Note
        // that this is only needed for the fallback solution using integer textures to encode positions
        const halfSize = morph.aabb.halfExtents;
        this._aabbSize = new Float32Array([halfSize.x * 4, halfSize.y * 4, halfSize.z * 4]);
        const min = morph.aabb.getMin();
        this._aabbMin = new Float32Array([min.x * 2, min.y * 2, min.z * 2]);

        // aabb size and min factors for normal rendering, where the range is -1..1
        this._aabbNrmSize = new Float32Array([2, 2, 2]);
        this._aabbNrmMin = new Float32Array([-1, -1, -1]);

        this.aabbSizeId = this.device.scope.resolve('aabbSize');
        this.aabbMinId = this.device.scope.resolve('aabbMin');

        // resolve possible texture names
        for (let i = 0; i < this.maxSubmitCount; i++) {
            this[`morphBlendTex${i}`] = this.device.scope.resolve(`morphBlendTex${i}`);
        }

        this.morphFactor = this.device.scope.resolve('morphFactor[0]');

        // true indicates render target textures are full of zeros to avoid rendering to them when all weights are zero
        this.zeroTextures = false;
    }

    /**
     * Frees video memory allocated by this object.
     */
    destroy() {

        // don't destroy shader as it's in the cache and can be used by other materials
        this.shader = null;

        const morph = this.morph;
        if (morph) {

            // decrease ref count
            this.morph = null;
            morph.decRefCount();

            // destroy morph
            if (morph.refCount < 1) {
                morph.destroy();
            }
        }

        if (this.rtPositions) {
            this.rtPositions.destroy();
            this.rtPositions = null;
        }

        if (this.texturePositions) {
            this.texturePositions.destroy();
            this.texturePositions = null;
        }

        if (this.rtNormals) {
            this.rtNormals.destroy();
            this.rtNormals = null;
        }

        if (this.textureNormals) {
            this.textureNormals.destroy();
            this.textureNormals = null;
        }
    }

    /**
     * Clones a MorphInstance. The returned clone uses the same {@link Morph} and weights are set
     * to defaults.
     *
     * @returns {MorphInstance} A clone of the specified MorphInstance.
     */
    clone() {
        return new MorphInstance(this.morph);
    }

    _getWeightIndex(key) {
        if (typeof key === 'string') {
            const index = this._weightMap.get(key);
            if (index === undefined) {
                Debug.error(`Cannot find morph target with name: ${key}.`);
            }
            return index;
        }
        return key;
    }

    /**
     * Gets current weight of the specified morph target.
     *
     * @param {string|number} key - An identifier for the morph target. Either the weight index or
     * the weight name.
     * @returns {number} Weight.
     */
    getWeight(key) {
        const index = this._getWeightIndex(key);
        return this._weights[index];
    }

    /**
     * Sets weight of the specified morph target.
     *
     * @param {string|number} key - An identifier for the morph target. Either the weight index or
     * the weight name.
     * @param {number} weight - Weight.
     */
    setWeight(key, weight) {
        const index = this._getWeightIndex(key);
        Debug.assert(index >= 0 && index < this.morph._targets.length);
        this._weights[index] = weight;
        this._dirty = true;
    }

    /**
     * Create complete shader for texture based morphing.
     *
     * @param {number} count - Number of textures to blend.
     * @returns {Shader} Shader.
     * @private
     */
    _getShader(count) {

        let shader = this.shaderCache[count];

        // if shader is not in cache, generate one
        if (!shader) {

            const wgsl = this.device.isWebGPU;
            const chunks = wgsl ? shaderChunksWGSL : shaderChunks;

            const defines = new Map();
            defines.set('MORPH_TEXTURE_COUNT', count);
            defines.set('{MORPH_TEXTURE_COUNT}', count);
            if (this.morph.intRenderFormat) defines.set('MORPH_INT', '');

            const includes = new Map();
            includes.set('morphDeclarationPS', chunks.morphDeclarationPS);
            includes.set('morphEvaluationPS', chunks.morphEvaluationPS);

            const outputType = this.morph.intRenderFormat ? 'uvec4' : 'vec4';
            shader = createShaderFromCode(this.device, chunks.morphVS, chunks.morphPS, `textureMorph${count}`, {
                vertex_position: SEMANTIC_POSITION
            }, {
                shaderLanguage: wgsl ? SHADERLANGUAGE_WGSL : SHADERLANGUAGE_GLSL,
                fragmentIncludes: includes,
                fragmentDefines: defines,
                fragmentOutputTypes: [outputType]
            });
            this.shaderCache[count] = shader;
        }

        return shader;
    }

    _updateTextureRenderTarget(renderTarget, srcTextureName, isPos) {

        const device = this.device;

        // blend currently set up textures to render target
        const submitBatch = (usedCount, blending) => {

            // factors
            this.morphFactor.setValue(this._shaderMorphWeights);

            // alpha blending - first pass gets none, following passes are additive
            device.setBlendState(blending ? blendStateAdditive : BlendState.NOBLEND);

            // render quad with shader for required number of textures
            const shader = this._getShader(usedCount);
            drawQuadWithShader(device, renderTarget, shader);
        };

        this.setAabbUniforms(isPos);

        // set up parameters for active blend targets
        let usedCount = 0;
        let blending = false;
        const count = this._activeTargets.length;
        for (let i = 0; i < count; i++) {
            const activeTarget = this._activeTargets[i];
            const tex = activeTarget.target[srcTextureName];
            if (tex) {

                // texture
                this[`morphBlendTex${usedCount}`].setValue(tex);

                // weight
                this._shaderMorphWeights[usedCount] = activeTarget.weight;

                // submit if batch is full
                usedCount++;
                if (usedCount >= this.maxSubmitCount) {

                    submitBatch(usedCount, blending);
                    usedCount = 0;
                    blending = true;
                }
            }
        }

        // leftover batch, or just to clear texture
        if (usedCount > 0 || (count === 0 && !this.zeroTextures)) {
            submitBatch(usedCount, blending);
        }
    }

    _updateTextureMorph() {

        const device = this.device;

        DebugGraphics.pushGpuMarker(device, 'MorphUpdate');

        // update textures if active targets, or no active targets and textures need to be cleared
        if (this._activeTargets.length > 0 || !this.zeroTextures) {

            // blend morph targets into render targets
            if (this.rtPositions) {
                this._updateTextureRenderTarget(this.rtPositions, 'texturePositions', true);
            }

            if (this.rtNormals) {
                this._updateTextureRenderTarget(this.rtNormals, 'textureNormals', false);
            }

            // textures were cleared if no active targets
            this.zeroTextures = this._activeTargets.length === 0;
        }

        DebugGraphics.popGpuMarker(device);
    }

    setAabbUniforms(isPos = true) {
        this.aabbSizeId.setValue(isPos ? this._aabbSize : this._aabbNrmSize);
        this.aabbMinId.setValue(isPos ? this._aabbMin : this._aabbNrmMin);
    }


    prepareRendering(device) {
        this.setAabbUniforms();
    }

    /**
     * Selects active morph targets and prepares morph for rendering. Called automatically by
     * renderer.
     */
    update() {

        this._dirty = false;
        const targets = this.morph._targets;

        // collect active targets, reuse objects in _activeTargets array to avoid allocations
        let activeCount = 0;
        const epsilon = 0.00001;
        for (let i = 0; i < targets.length; i++) {
            const absWeight = Math.abs(this.getWeight(i));
            if (absWeight > epsilon) {

                // create new object if needed
                if (this._activeTargets.length <= activeCount) {
                    this._activeTargets[activeCount] = {};
                }

                const activeTarget = this._activeTargets[activeCount++];
                activeTarget.absWeight = absWeight;
                activeTarget.weight = this.getWeight(i);
                activeTarget.target = targets[i];
            }
        }
        this._activeTargets.length = activeCount;

        // with int texture, we do not have blending and so only support a single submit
        if (this.morph.intRenderFormat) {
            if (this._activeTargets.length > this.maxSubmitCount) {

                // sort them by absWeight
                this._activeTargets.sort((l, r) => {
                    return (l.absWeight < r.absWeight) ? 1 : (r.absWeight < l.absWeight ? -1 : 0);
                });

                // remove excess
                this._activeTargets.length = this.maxSubmitCount;
            }
        }

        // prepare for rendering
        this._updateTextureMorph();
    }
}

export { MorphInstance };
