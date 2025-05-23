// --------------- POST EFFECT DEFINITION --------------- //
/**
 * @class
 * @name EdgeDetectEffect
 * @classdesc Edge Detection post effect using Sobel filter.
 * @description Creates new instance of the post effect.
 * @augments PostEffect
 * @param {GraphicsDevice} graphicsDevice - The graphics device of the application.
 */
function EdgeDetectEffect(graphicsDevice) {
    pc.PostEffect.call(this, graphicsDevice);

    var fshader = [
        'uniform sampler2D uColorBuffer;',
        'varying vec2 vUv0;',
        'uniform vec2 uResolution;',
        'uniform float uIntensity;',
        'uniform vec4 uColor;',
        '',
        'mat3 G[2];',
        '',
        'const mat3 g0 = mat3( 1.0, 2.0, 1.0, 0.0, 0.0, 0.0, -1.0, -2.0, -1.0 );',
        'const mat3 g1 = mat3( 1.0, 0.0, -1.0, 2.0, 0.0, -2.0, 1.0, 0.0, -1.0 );',
        '',
        'void main(void)',
        '{',
        '    mat3 I;',
        '    float cnv[2];',
        '    vec3 sample;',
        '',
        '    G[0] = g0;',
        '    G[1] = g1;',
        '',
        /* Fetch the 3x3 neighbourhood and use the RGB vector's length as intensity value */
        '    for (float i = 0.0; i < 3.0; i++)',
        '    {',
        '        for (float j = 0.0; j < 3.0; j++)',
        '        {',
        '            sample = texture2D(uColorBuffer, vUv0 + uResolution * vec2(i - 1.0, j - 1.0)).rgb;',
        '            I[int(i)][int(j)] = length(sample);',
        '         }',
        '    }',
        '',
        /* Calculate the convolution values for all the masks */
        '    for (int i=0; i<2; i++)',
        '    {',
        '        float dp3 = dot(G[i][0], I[0]) + dot(G[i][1], I[1]) + dot(G[i][2], I[2]);',
        '        cnv[i] = dp3 * dp3; ',
        '    }',
        '',
        '    gl_FragColor = uIntensity * uColor * vec4(sqrt(cnv[0]*cnv[0]+cnv[1]*cnv[1]));',
        '}'
    ].join('\n');

    this.shader = pc.ShaderUtils.createShader(graphicsDevice, {
        uniqueName: 'EdgeDetectShader',
        attributes: { aPosition: pc.SEMANTIC_POSITION },
        vertexGLSL: pc.PostEffect.quadVertexShader,
        fragmentGLSL: fshader
    });

    // Uniforms
    this.resolution = new Float32Array(2);
    this.intensity = 1.0;
    this.color = new pc.Color(1, 1, 1, 1);
}

EdgeDetectEffect.prototype = Object.create(pc.PostEffect.prototype);
EdgeDetectEffect.prototype.constructor = EdgeDetectEffect;

Object.assign(EdgeDetectEffect.prototype, {
    render: function (inputTarget, outputTarget, rect) {
        var device = this.device;
        var scope = device.scope;

        this.resolution[0] = 1 / inputTarget.width;
        this.resolution[1] = 1 / inputTarget.height;
        scope.resolve('uResolution').setValue(this.resolution);
        scope.resolve('uColorBuffer').setValue(inputTarget.colorBuffer);
        scope.resolve('uColor').setValue(this.color.data);
        scope.resolve('uIntensity').setValue(this.intensity);
        this.drawQuad(outputTarget, this.shader, rect);
    }
});

// ----------------- SCRIPT DEFINITION ------------------ //
var EdgeDetect = pc.createScript('edgeDetect');

EdgeDetect.attributes.add('intensity', {
    type: 'number',
    default: 1,
    min: 0,
    max: 2,
    title: 'Intensity'
});

EdgeDetect.attributes.add('color', {
    type: 'rgba',
    default: [0.5, 0.5, 0.5, 1],
    title: 'Color'
});

// initialize code called once per entity
EdgeDetect.prototype.initialize = function () {
    this.effect = new EdgeDetectEffect(this.app.graphicsDevice);
    this.effect.intensity = this.intensity;
    this.effect.color = this.color;

    this.on('attr', function (name, value) {
        this.effect[name] = value;
    }, this);

    var queue = this.entity.camera.postEffects;

    queue.addEffect(this.effect);

    this.on('state', function (enabled) {
        if (enabled) {
            queue.addEffect(this.effect);
        } else {
            queue.removeEffect(this.effect);
        }
    });

    this.on('destroy', function () {
        queue.removeEffect(this.effect);
    });
};
