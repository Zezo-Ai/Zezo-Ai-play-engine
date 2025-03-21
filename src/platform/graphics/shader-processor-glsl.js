import { Debug } from '../../core/debug.js';
import {
    BINDGROUP_MESH, uniformTypeToName, semanticToLocation,
    SHADERSTAGE_VERTEX, SHADERSTAGE_FRAGMENT,
    SAMPLETYPE_FLOAT, SAMPLETYPE_DEPTH, SAMPLETYPE_UNFILTERABLE_FLOAT,
    TEXTUREDIMENSION_2D, TEXTUREDIMENSION_2D_ARRAY, TEXTUREDIMENSION_CUBE, TEXTUREDIMENSION_3D,
    TYPE_FLOAT32, TYPE_INT8, TYPE_INT16, TYPE_INT32, TYPE_FLOAT16, SAMPLETYPE_INT, SAMPLETYPE_UINT,
    BINDGROUP_MESH_UB,
    UNUSED_UNIFORM_NAME,
    UNIFORMTYPE_FLOAT,
    bindGroupNames
} from './constants.js';
import { UniformFormat, UniformBufferFormat } from './uniform-buffer-format.js';
import { BindGroupFormat, BindTextureFormat } from './bind-group-format.js';

/**
 * @import { GraphicsDevice } from './graphics-device.js'
 * @import { ShaderProcessorOptions } from './shader-processor-options.js'
 * @import { Shader } from './shader.js'
 */

// accepted keywords
// TODO: 'out' keyword is not in the list, as handling it is more complicated due
// to 'out' keyword also being used to mark output only function parameters.
const KEYWORD = /[ \t]*(\battribute\b|\bvarying\b|\buniform\b)/g;

// match 'attribute' and anything else till ';'
// eslint-disable-next-line regexp/no-unused-capturing-group, regexp/no-super-linear-backtracking
const KEYWORD_LINE = /(\battribute\b|\bvarying\b|\bout\b|\buniform\b)[ \t]*([^;]+)(;+)/g;

// marker for a place in the source code to be replaced by code
const MARKER = '@@@';

// an array identifier, for example 'data[4]' - group 1 is 'data', group 2 is everything in brackets: '4'
const ARRAY_IDENTIFIER = /([\w-]+)\[(.*?)\]/;

const precisionQualifiers = new Set(['highp', 'mediump', 'lowp']);
const shadowSamplers = new Set(['sampler2DShadow', 'samplerCubeShadow', 'sampler2DArrayShadow']);
const textureDimensions = {
    sampler2D: TEXTUREDIMENSION_2D,
    sampler3D: TEXTUREDIMENSION_3D,
    samplerCube: TEXTUREDIMENSION_CUBE,
    samplerCubeShadow: TEXTUREDIMENSION_CUBE,
    sampler2DShadow: TEXTUREDIMENSION_2D,
    sampler2DArray: TEXTUREDIMENSION_2D_ARRAY,
    sampler2DArrayShadow: TEXTUREDIMENSION_2D_ARRAY,
    isampler2D: TEXTUREDIMENSION_2D,
    usampler2D: TEXTUREDIMENSION_2D,
    isampler3D: TEXTUREDIMENSION_3D,
    usampler3D: TEXTUREDIMENSION_3D,
    isamplerCube: TEXTUREDIMENSION_CUBE,
    usamplerCube: TEXTUREDIMENSION_CUBE,
    isampler2DArray: TEXTUREDIMENSION_2D_ARRAY,
    usampler2DArray: TEXTUREDIMENSION_2D_ARRAY
};

const textureDimensionInfo = {
    [TEXTUREDIMENSION_2D]: 'texture2D',
    [TEXTUREDIMENSION_CUBE]: 'textureCube',
    [TEXTUREDIMENSION_3D]: 'texture3D',
    [TEXTUREDIMENSION_2D_ARRAY]: 'texture2DArray'
};

class UniformLine {
    constructor(line, shader) {

        // example: `lowp vec4 tints[2 * 4]`
        this.line = line;

        // split to words handling any number of spaces
        const words = line.trim().split(/\s+/);

        // optional precision
        if (precisionQualifiers.has(words[0])) {
            this.precision = words.shift();
        }

        // type
        this.type = words.shift();

        if (line.includes(',')) {
            Debug.error(`A comma on a uniform line is not supported, split it into multiple uniforms: ${line}`, shader);
        }

        // array of uniforms
        if (line.includes('[')) {

            const rest = words.join(' ');
            const match = ARRAY_IDENTIFIER.exec(rest);
            Debug.assert(match);

            this.name = match[1];
            this.arraySize = Number(match[2]);
            if (isNaN(this.arraySize)) {
                shader.failed = true;
                Debug.error(`Only numerically specified uniform array sizes are supported, this uniform is not supported: '${line}'`, shader);
            }

        } else {

            // simple uniform
            this.name = words.shift();
            this.arraySize = 0;
        }

        this.isSampler = this.type.indexOf('sampler') !== -1;
        this.isSignedInt = this.type.indexOf('isampler') !== -1;
        this.isUnsignedInt = this.type.indexOf('usampler') !== -1;
    }
}

/**
 * Pure static class implementing processing of GLSL shaders. It allocates fixed locations for
 * attributes, and handles conversion of uniforms to uniform buffers.
 */
class ShaderProcessorGLSL {
    /**
     * Process the shader.
     *
     * @param {GraphicsDevice} device - The graphics device.
     * @param {object} shaderDefinition - The shader definition.
     * @param {Shader} shader - The shader.
     * @returns {object} - The processed shader data.
     */
    static run(device, shaderDefinition, shader) {

        /** @type {Map<string, number>} */
        const varyingMap = new Map();

        // extract lines of interests from both shaders
        const vertexExtracted = ShaderProcessorGLSL.extract(shaderDefinition.vshader);
        const fragmentExtracted = ShaderProcessorGLSL.extract(shaderDefinition.fshader);

        // VS - convert a list of attributes to a shader block with fixed locations
        const attributesMap = new Map();
        const attributesBlock = ShaderProcessorGLSL.processAttributes(vertexExtracted.attributes, shaderDefinition.attributes, attributesMap, shaderDefinition.processingOptions);

        // VS - convert a list of varyings to a shader block
        const vertexVaryingsBlock = ShaderProcessorGLSL.processVaryings(vertexExtracted.varyings, varyingMap, true);

        // FS - convert a list of varyings to a shader block
        const fragmentVaryingsBlock = ShaderProcessorGLSL.processVaryings(fragmentExtracted.varyings, varyingMap, false);

        // FS - convert a list of outputs to a shader block
        const outBlock = ShaderProcessorGLSL.processOuts(fragmentExtracted.outs);

        // uniforms - merge vertex and fragment uniforms, and create shared uniform buffers
        // Note that as both vertex and fragment can declare the same uniform, we need to remove duplicates
        const concatUniforms = vertexExtracted.uniforms.concat(fragmentExtracted.uniforms);
        const uniforms = Array.from(new Set(concatUniforms));

        // parse uniform lines
        const parsedUniforms = uniforms.map(line => new UniformLine(line, shader));

        // validation - as uniforms go to a shared uniform buffer, vertex and fragment versions need to match
        Debug.call(() => {
            const map = new Map();
            parsedUniforms.forEach((uni) => {
                const existing = map.get(uni.name);
                Debug.assert(!existing, `Vertex and fragment shaders cannot use the same uniform name with different types: '${existing}' and '${uni.line}'`, shader);
                map.set(uni.name, uni.line);
            });
        });
        const uniformsData = ShaderProcessorGLSL.processUniforms(device, parsedUniforms, shaderDefinition.processingOptions, shader);

        // VS - insert the blocks to the source
        const vBlock = `${attributesBlock}\n${vertexVaryingsBlock}\n${uniformsData.code}`;
        const vshader = vertexExtracted.src.replace(MARKER, vBlock);

        // FS - insert the blocks to the source
        const fBlock = `${fragmentVaryingsBlock}\n${outBlock}\n${uniformsData.code}`;
        const fshader = fragmentExtracted.src.replace(MARKER, fBlock);

        return {
            vshader: vshader,
            fshader: fshader,
            attributes: attributesMap,
            meshUniformBufferFormat: uniformsData.meshUniformBufferFormat,
            meshBindGroupFormat: uniformsData.meshBindGroupFormat
        };
    }

    // Extract required information from the shader source code.
    static extract(src) {

        // collected data
        const attributes = [];
        const varyings = [];
        const outs = [];
        const uniforms = [];

        // replacement marker - mark a first replacement place, this is where code
        // blocks are injected later
        let replacement = `${MARKER}\n`;

        // extract relevant parts of the shader
        let match;
        while ((match = KEYWORD.exec(src)) !== null) {

            const keyword = match[1];
            switch (keyword) {
                case 'attribute':
                case 'varying':
                case 'uniform':
                case 'out': {

                    // read the line
                    KEYWORD_LINE.lastIndex = match.index;
                    const lineMatch = KEYWORD_LINE.exec(src);

                    if (keyword === 'attribute') {
                        attributes.push(lineMatch[2]);
                    } else if (keyword === 'varying') {
                        varyings.push(lineMatch[2]);
                    } else if (keyword === 'out') {
                        outs.push(lineMatch[2]);
                    } else if (keyword === 'uniform') {
                        uniforms.push(lineMatch[2]);
                    }

                    // cut it out
                    src = ShaderProcessorGLSL.cutOut(src, match.index, KEYWORD_LINE.lastIndex, replacement);
                    KEYWORD.lastIndex = match.index + replacement.length;

                    // only place a single replacement marker
                    replacement = '';
                    break;
                }
            }
        }

        return {
            src,
            attributes,
            varyings,
            outs,
            uniforms
        };
    }

    /**
     * Process the lines with uniforms. The function receives the lines containing all uniforms,
     * both numerical as well as textures/samplers. The function also receives the format of uniform
     * buffers (numerical) and bind groups (textures) for view and material level. All uniforms that
     * match any of those are ignored, as those would be supplied by view / material level buffers.
     * All leftover uniforms create uniform buffer and bind group for the mesh itself, containing
     * uniforms that change on the level of the mesh.
     *
     * @param {GraphicsDevice} device - The graphics device.
     * @param {Array<UniformLine>} uniforms - Lines containing uniforms.
     * @param {ShaderProcessorOptions} processingOptions - Uniform formats.
     * @param {Shader} shader - The shader definition.
     * @returns {object} - The uniform data. Returns a shader code block containing uniforms, to be
     * inserted into the shader, as well as generated uniform format structures for the mesh level.
     */
    static processUniforms(device, uniforms, processingOptions, shader) {

        // split uniform lines into samplers and the rest
        /** @type {Array<UniformLine>} */
        const uniformLinesSamplers = [];
        /** @type {Array<UniformLine>} */
        const uniformLinesNonSamplers = [];
        uniforms.forEach((uniform) => {
            if (uniform.isSampler) {
                uniformLinesSamplers.push(uniform);
            } else {
                uniformLinesNonSamplers.push(uniform);
            }
        });

        // build mesh uniform buffer format
        const meshUniforms = [];
        uniformLinesNonSamplers.forEach((uniform) => {
            // uniforms not already in supplied uniform buffers go to the mesh buffer
            if (!processingOptions.hasUniform(uniform.name)) {
                const uniformType = uniformTypeToName.indexOf(uniform.type);
                Debug.assert(uniformType >= 0, `Uniform type ${uniform.type} is not recognized on line [${uniform.line}]`);
                const uniformFormat = new UniformFormat(uniform.name, uniformType, uniform.arraySize);
                Debug.assert(!uniformFormat.invalid, `Invalid uniform line: ${uniform.line}`, shader);
                meshUniforms.push(uniformFormat);
            }

            // validate types in else

        });

        // if we don't have any uniform, add a dummy uniform to avoid empty uniform buffer - WebGPU rendering does not
        // support rendering will NULL bind group as binding a null buffer changes placement of other bindings
        if (meshUniforms.length === 0) {
            meshUniforms.push(new UniformFormat(UNUSED_UNIFORM_NAME, UNIFORMTYPE_FLOAT));
        }

        const meshUniformBufferFormat = meshUniforms.length ? new UniformBufferFormat(device, meshUniforms) : null;

        // build mesh bind group format - this contains the textures, but not the uniform buffer as that is a separate binding
        const textureFormats = [];
        uniformLinesSamplers.forEach((uniform) => {
            // unmatched texture uniforms go to mesh block
            if (!processingOptions.hasTexture(uniform.name)) {

                // sample type
                // WebGpu does not currently support filtered float format textures, and so we map them to unfilterable type
                // as we sample them without filtering anyways
                let sampleType = SAMPLETYPE_FLOAT;
                if (uniform.isSignedInt) {
                    sampleType = SAMPLETYPE_INT;
                } else if (uniform.isUnsignedInt) {
                    sampleType = SAMPLETYPE_UINT;
                } else {
                    if (uniform.precision === 'highp') {
                        sampleType = SAMPLETYPE_UNFILTERABLE_FLOAT;
                    }
                    if (shadowSamplers.has(uniform.type)) {
                        sampleType = SAMPLETYPE_DEPTH;
                    }
                }

                // dimension
                const dimension = textureDimensions[uniform.type];

                // TODO: we could optimize visibility to only stages that use any of the data
                textureFormats.push(new BindTextureFormat(uniform.name, SHADERSTAGE_VERTEX | SHADERSTAGE_FRAGMENT, dimension, sampleType));
            }

            // validate types in else

        });
        const meshBindGroupFormat = new BindGroupFormat(device, textureFormats);

        // generate code for uniform buffers
        let code = '';
        processingOptions.uniformFormats.forEach((format, bindGroupIndex) => {
            if (format) {
                code += ShaderProcessorGLSL.getUniformShaderDeclaration(format, bindGroupIndex, 0);
            }
        });

        // and also for generated mesh format, which is at the slot 0 of the bind group
        if (meshUniformBufferFormat) {
            code += ShaderProcessorGLSL.getUniformShaderDeclaration(meshUniformBufferFormat, BINDGROUP_MESH_UB, 0);
        }

        // generate code for textures
        processingOptions.bindGroupFormats.forEach((format, bindGroupIndex) => {
            if (format) {
                code += ShaderProcessorGLSL.getTexturesShaderDeclaration(format, bindGroupIndex);
            }
        });

        // and also for generated mesh format
        code += ShaderProcessorGLSL.getTexturesShaderDeclaration(meshBindGroupFormat, BINDGROUP_MESH);

        return {
            code,
            meshUniformBufferFormat,
            meshBindGroupFormat
        };
    }

    static processVaryings(varyingLines, varyingMap, isVertex) {
        let block = '';
        const op = isVertex ? 'out' : 'in';
        varyingLines.forEach((line, index) => {
            const words = ShaderProcessorGLSL.splitToWords(line);
            const type = words.slice(0, -1).join(' ');
            const name = words[words.length - 1];

            if (isVertex) {
                // store it in the map
                varyingMap.set(name, index);
            } else {
                Debug.assert(varyingMap.has(name), `Fragment shader requires varying [${name}] but vertex shader does not generate it.`);
                index = varyingMap.get(name);
            }

            // generates: 'layout(location = 0) in vec4 position;'
            block += `layout(location = ${index}) ${op} ${type} ${name};\n`;
        });
        return block;
    }

    static processOuts(outsLines) {
        let block = '';
        outsLines.forEach((line, index) => {
            // generates: 'layout(location = 0) out vec4 gl_FragColor;'
            block += `layout(location = ${index}) out ${line};\n`;
        });
        return block;
    }

    // extract count from type ('vec3' => 3, 'float' => 1)
    static getTypeCount(type) {
        const lastChar = type.substring(type.length - 1);
        const num = parseInt(lastChar, 10);
        return isNaN(num) ? 1 : num;
    }

    static processAttributes(attributeLines, shaderDefinitionAttributes, attributesMap, processingOptions) {
        let block = '';
        const usedLocations = {};
        attributeLines.forEach((line) => {
            const words = ShaderProcessorGLSL.splitToWords(line);
            let type = words[0];
            let name = words[1];

            if (shaderDefinitionAttributes.hasOwnProperty(name)) {
                const semantic = shaderDefinitionAttributes[name];
                const location = semanticToLocation[semantic];
                Debug.assert(location !== undefined, `Semantic ${semantic} used by the attribute ${name} is not known - make sure it's one of the supported semantics.`);

                Debug.assert(!usedLocations.hasOwnProperty(location),
                    `WARNING: Two vertex attributes are mapped to the same location in a shader: ${usedLocations[location]} and ${semantic}`);
                usedLocations[location] = semantic;

                // build a map of used attributes
                attributesMap.set(location, name);

                // if vertex format for this attribute is not of a float type, we need to adjust the attribute format, for example we convert
                //      attribute vec4 vertex_position;
                // to
                //      attribute ivec4 _private_vertex_position;
                //      vec4 vertex_position = vec4(_private_vertex_position);
                // Note that we skip normalized elements, as shader receives them as floats already.
                let copyCode;
                const element = processingOptions.getVertexElement(semantic);
                if (element) {
                    const dataType = element.dataType;
                    if (dataType !== TYPE_FLOAT32 && dataType !== TYPE_FLOAT16 && !element.normalize && !element.asInt) {

                        const attribNumElements = ShaderProcessorGLSL.getTypeCount(type);
                        const newName = `_private_${name}`;

                        // second line of new code, copy private (u)int type into vec type
                        copyCode = `vec${attribNumElements} ${name} = vec${attribNumElements}(${newName});\n`;

                        name = newName;

                        // new attribute type, based on the vertex format element type, example: vec3 -> ivec3
                        const isSignedType = dataType === TYPE_INT8 || dataType === TYPE_INT16 || dataType === TYPE_INT32;
                        if (attribNumElements === 1) {
                            type = isSignedType ? 'int' : 'uint';
                        } else {
                            type = isSignedType ? `ivec${attribNumElements}` : `uvec${attribNumElements}`;
                        }
                    }
                }

                // generates: 'layout(location = 0) in vec4 position;'
                block += `layout(location = ${location}) in ${type} ${name};\n`;

                if (copyCode) {
                    block += copyCode;
                }
            }
        });
        return block;
    }

    static splitToWords(line) {
        // remove any double spaces
        line = line.replace(/\s+/g, ' ').trim();
        return line.split(' ');
    }

    static cutOut(src, start, end, replacement) {
        return src.substring(0, start) + replacement + src.substring(end);
    }

    static getUniformShaderDeclaration(format, bindGroup, bindIndex) {
        const name = bindGroupNames[bindGroup];
        let code = `layout(set = ${bindGroup}, binding = ${bindIndex}, std140) uniform ub_${name} {\n`;

        format.uniforms.forEach((uniform) => {
            const typeString = uniformTypeToName[uniform.type];
            Debug.assert(typeString.length > 0, `Uniform type ${uniform.type} is not handled.`);
            code += `    ${typeString} ${uniform.shortName}${uniform.count ? `[${uniform.count}]` : ''};\n`;
        });

        return `${code}};\n`;
    }

    static getTexturesShaderDeclaration(bindGroupFormat, bindGroup) {
        let code = '';
        bindGroupFormat.textureFormats.forEach((format) => {

            let textureType = textureDimensionInfo[format.textureDimension];
            Debug.assert(textureType, 'Unsupported texture type', format.textureDimension);
            const isArray = textureType === 'texture2DArray';

            const sampleTypePrefix = format.sampleType === SAMPLETYPE_UINT ? 'u' : (format.sampleType === SAMPLETYPE_INT ? 'i' : '');
            textureType = `${sampleTypePrefix}${textureType}`;

            // handle texture2DArray by renaming the texture object and defining a replacement macro
            let namePostfix = '';
            let extraCode = '';
            if (isArray) {
                namePostfix = '_texture';
                extraCode = `#define ${format.name} ${sampleTypePrefix}sampler2DArray(${format.name}${namePostfix}, ${format.name}_sampler)\n`;
            }

            code += `layout(set = ${bindGroup}, binding = ${format.slot}) uniform ${textureType} ${format.name}${namePostfix};\n`;
            if (format.hasSampler) {
                code += `layout(set = ${bindGroup}, binding = ${format.slot + 1}) uniform sampler ${format.name}_sampler;\n`;
            }
            code += extraCode;
        });

        return code;
    }
}

export { ShaderProcessorGLSL };
