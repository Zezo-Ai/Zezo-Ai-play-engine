import {
    ShaderMaterial,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    BLEND_NORMAL,
    CULLFACE_NONE,
    PlaneGeometry,
    Mesh,
    MeshInstance,
    Color,
    Script,
    Vec2
} from 'playcanvas';

const tmpVa = new Vec2();

const EPISILON = 1e-3;

const vertexGLSL = /* glsl */ `
    attribute vec3 vertex_position;
    attribute vec2 aUv0;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    varying vec2 uv0;

    void main(void) {
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
        uv0 = aUv0;
    }
`;

const fragmentGLSL = /* glsl */ `
    uniform vec2 uHalfExtents;
    uniform vec3 uColorX;
    uniform vec3 uColorZ;
    uniform int uResolution;

    varying vec2 uv0;

    // https://bgolus.medium.com/the-best-darn-grid-shader-yet-727f9278b9d8#1e7c
    float pristineGrid(in vec2 uv, in vec2 ddx, in vec2 ddy, vec2 lineWidth) {
        vec2 uvDeriv = vec2(length(vec2(ddx.x, ddy.x)), length(vec2(ddx.y, ddy.y)));
        bvec2 invertLine = bvec2(lineWidth.x > 0.5, lineWidth.y > 0.5);
        vec2 targetWidth = vec2(
            invertLine.x ? 1.0 - lineWidth.x : lineWidth.x,
            invertLine.y ? 1.0 - lineWidth.y : lineWidth.y
        );
        vec2 drawWidth = clamp(targetWidth, uvDeriv, vec2(0.5));
        vec2 lineAA = uvDeriv * 1.5;
        vec2 gridUV = abs(fract(uv) * 2.0 - 1.0);
        gridUV.x = invertLine.x ? gridUV.x : 1.0 - gridUV.x;
        gridUV.y = invertLine.y ? gridUV.y : 1.0 - gridUV.y;
        vec2 grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);

        grid2 *= clamp(targetWidth / drawWidth, 0.0, 1.0);
        grid2 = mix(grid2, targetWidth, clamp(uvDeriv * 2.0 - 1.0, 0.0, 1.0));
        grid2.x = invertLine.x ? 1.0 - grid2.x : grid2.x;
        grid2.y = invertLine.y ? 1.0 - grid2.y : grid2.y;

        return mix(grid2.x, 1.0, grid2.y);
    }

    void main(void) {
        vec2 uv = uv0;

        vec2 pos = (uv * 2.0 - 1.0) * uHalfExtents;
        vec2 ddx = dFdx(pos);
        vec2 ddy = dFdy(pos);

        float epsilon = 1.0 / 255.0;

        vec2 levelPos;
        float levelSize;
        float levelAlpha;

        levelPos = pos * 0.1;
        levelSize = 2.0 / 1000.0;
        levelAlpha = pristineGrid(levelPos, ddx * 0.1, ddy * 0.1, vec2(levelSize));
        if (levelAlpha > epsilon) {
            vec3 color;
            if (abs(levelPos.x) < levelSize) {
                if (abs(levelPos.y) < levelSize) {
                    color = vec3(1.0);
                } else {
                    color = uColorZ;
                }
            } else if (abs(levelPos.y) < levelSize) {
                color = uColorX;
            } else {
                color = vec3(0.9);
            }
            gl_FragColor = vec4(color, levelAlpha);
            return;
        }

        levelPos = pos;
        levelSize = 1.0 / 100.0;
        levelAlpha = pristineGrid(levelPos, ddx, ddy, vec2(levelSize));
        if (levelAlpha > epsilon) {
            if (uResolution < 1) {
                discard;
            }
            gl_FragColor = vec4(vec3(0.7), levelAlpha);
            return;
        }

        levelPos = pos * 10.0;
        levelSize = 1.0 / 100.0;
        levelAlpha = pristineGrid(levelPos, ddx * 10.0, ddy * 10.0, vec2(levelSize));
        if (levelAlpha > epsilon) {
            if (uResolution < 2) {
                discard;
            }
            gl_FragColor = vec4(vec3(0.7), levelAlpha);
            return;
        }

        discard;
    }
`;

const vertexWGSL = /* wgsl */ `
    attribute vertex_position: vec3f;
    attribute aUv0: vec2f;

    uniform matrix_model: mat4x4f;
    uniform matrix_viewProjection: mat4x4f;

    varying uv0: vec2f;

    @vertex
    fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniform.matrix_viewProjection * uniform.matrix_model * vec4f(input.vertex_position, 1.0);
        output.uv0 = input.aUv0;
        return output;
    }
`;

const fragmentWGSL = /* wgsl */ `
    uniform uHalfExtents: vec2f;
    uniform uColorX: vec3f;
    uniform uColorZ: vec3f;
    uniform uResolution: u32;

    varying uv0: vec2f;

    // https://bgolus.medium.com/the-best-darn-grid-shader-yet-727f9278b9d8#1e7c
    fn pristineGrid(uv: vec2f, ddx: vec2f, ddy: vec2f, lineWidth: vec2f) -> f32 {
        let uvDeriv = vec2f(length(vec2f(ddx.x, ddy.x)), length(vec2f(ddx.y, ddy.y)));
        let invertLine = vec2<bool>(lineWidth.x > 0.5, lineWidth.y > 0.5);
        let targetWidth = vec2f(
            select(lineWidth.x, 1.0 - lineWidth.x, invertLine.x),
            select(lineWidth.y, 1.0 - lineWidth.y, invertLine.y)
        );
        let drawWidth = clamp(targetWidth, uvDeriv, vec2f(0.5));
        let lineAA = uvDeriv * 1.5;
        var gridUV = abs(fract(uv) * 2.0 - 1.0);
        gridUV.x = select(1.0 - gridUV.x, gridUV.x, invertLine.x);
        gridUV.y = select(1.0 - gridUV.y, gridUV.y, invertLine.y);
        var grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);

        grid2 *= clamp(targetWidth / drawWidth, vec2f(0.0), vec2f(1.0));
        grid2 = mix(grid2, targetWidth, clamp(uvDeriv * 2.0 - 1.0, vec2f(0.0), vec2f(1.0)));
        grid2.x = select(grid2.x, 1.0 - grid2.x, invertLine.x);
        grid2.y = select(grid2.y, 1.0 - grid2.y, invertLine.y);

        return mix(grid2.x, 1.0, grid2.y);
    }

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let uv: vec2f = input.uv0;

        let pos: vec2f = (uv * 2.0 - 1.0) * uniform.uHalfExtents;
        let ddx: vec2f = dpdx(pos);
        let ddy: vec2f = dpdy(pos);

        let epsilon: f32 = 1.0 / 255.0;

        var levelPos: vec2f;
        var levelSize: f32;
        var levelAlpha: f32;

        levelPos = pos * 0.1;
        levelSize = 2.0 / 1000.0;
        levelAlpha = pristineGrid(levelPos, ddx * 0.1, ddy * 0.1, vec2f(levelSize));
        if (levelAlpha > epsilon) {
            var color: vec3f;
            if (abs(levelPos.x) < levelSize) {
                if (abs(levelPos.y) < levelSize) {
                    color = vec3f(1.0);
                } else {
                    color = uniform.uColorZ;
                }
            } else if (abs(levelPos.y) < levelSize) {
                color = uniform.uColorX;
            } else {
                color = vec3f(0.9);
            }
            output.color = vec4f(color, levelAlpha);
            return output;
        }

        levelPos = pos;
        levelSize = 1.0 / 100.0;
        levelAlpha = pristineGrid(levelPos, ddx, ddy, vec2f(levelSize));
        if (levelAlpha > epsilon) {
            if (uniform.uResolution < 1) {
                discard;
            }
            output.color = vec4f(vec3f(0.7), levelAlpha);
            return output;
        }

        levelPos = pos * 10.0;
        levelSize = 1.0 / 100.0;
        levelAlpha = pristineGrid(levelPos, ddx * 10.0, ddy * 10.0, vec2f(levelSize));
        if (levelAlpha > epsilon) {
            if (uniform.uResolution < 2) {
                discard;
            }
            output.color = vec4f(vec3f(0.7), levelAlpha);
            return output;
        }

        discard;
        return output;
    }
`;

class Grid extends Script {
    static scriptName = 'grid';

    /**
     * @type {number}
     */
    static RESOLUTION_LOW = 0;

    /**
     * @type {number}
     */
    static RESOLUTION_MEDIUM = 1;

    /**
     * @type {number}
     */
    static RESOLUTION_HIGH = 2;

    /**
     * @type {ShaderMaterial}
     * @private
     */
    _material;

    /**
     * @type {MeshInstance}
     * @private
     */
    _meshInstance;

    /**
     * @type {Vec2}
     * @private
     */
    _halfExtents = new Vec2();

    /**
     * @type {Color}
     * @private
     */
    _colorX = new Color(1, 0.3, 0.3);

    /**
     * @type {Color}
     * @private
     */
    _colorZ = new Color(0.3, 0.3, 1);

    /**
     * @type {number}
     * @private
     */
    _resolution = Grid.RESOLUTION_HIGH;

    initialize() {
        // check if the entity already has a render component
        if (this.entity.render) {
            console.error('The entity already has a render component.');
            return;
        }

        // create render component
        this.entity.addComponent('render', {
            castShadows: false
        });

        // create shader material
        this._material = new ShaderMaterial({
            uniqueName: 'grid-shader',
            vertexGLSL: vertexGLSL,
            fragmentGLSL: fragmentGLSL,
            vertexWGSL: vertexWGSL,
            fragmentWGSL: fragmentWGSL,
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                aUv0: SEMANTIC_TEXCOORD0
            }
        });
        this._material.blendType = BLEND_NORMAL;
        this._material.cull = CULLFACE_NONE;
        this._material.update();

        // create mesh
        const mesh = Mesh.fromGeometry(this.app.graphicsDevice, new PlaneGeometry());
        this._meshInstance = new MeshInstance(mesh, this._material);
        this.entity.render.meshInstances = [this._meshInstance];

        // set the initial values
        this.colorX = this._colorX;
        this.colorZ = this._colorZ;
        this.resolution = this._resolution;

        // calculate half extents
        this._set('uHalfExtents', this._calcHalfExtents(tmpVa));

        // update the half extents when the entity scale changes
        this.app.on('prerender', () => {
            if (!this.enabled) {
                return;
            }
            const halfExtents = this._calcHalfExtents(tmpVa);
            if (this._halfExtents.distance(halfExtents) > EPISILON) {
                this._set('uHalfExtents', halfExtents);
            }
        });

        // enable/disable the mesh instance
        this.on('enable', () => {
            this._meshInstance.visible = true;
        });
        this.on('disable', () => {
            this._meshInstance.visible = false;
        });

        this.on('destroy', this.destroy, this);
    }

    /**
     * @param {Vec2} vec - The vector to copy the half extents to.
     * @returns {Vec2} - The half extents.
     * @private
     */
    _calcHalfExtents(vec) {
        const scale = this.entity.getLocalScale();
        return vec.set(scale.x / 2, scale.z / 2);
    }

    /**
     * @param {string} name - The name of the parameter.
     * @param {Color|Vec2|number} value - The value of the parameter.
     * @private
     */
    _set(name, value) {
        if (!this._material) {
            return;
        }

        if (value instanceof Color) {
            this._material.setParameter(name, [value.r, value.g, value.b]);
        }

        if (value instanceof Vec2) {
            this._material.setParameter(name, [value.x, value.y]);
        }

        if (typeof value === 'number') {
            this._material.setParameter(name, value);
        }

        this._material.update();

        this._meshInstance.material = this._material;
    }

    /**
     * @attribute
     * @title Grid Color X
     * @description The color of the grid lines along the X axis.
     * @type {Color}
     * @default [1, 0.3, 0.3, 1]
     */
    set colorX(value) {
        if (!(value instanceof Color)) {
            return;
        }
        this._colorX.copy(value);
        this._set('uColorX', this._colorX);
    }

    get colorX() {
        return this._colorX;
    }

    /**
     * @attribute
     * @title Grid Color Z
     * @description The color of the grid lines along the Z axis.
     * @type {Color}
     * @default [0.3, 0.3, 1, 1]
     */
    set colorZ(value) {
        if (!(value instanceof Color)) {
            return;
        }
        this._colorZ.copy(value);
        this._set('uColorZ', this._colorZ);
    }

    get colorZ() {
        return this._colorZ;
    }

    /**
     * @attribute
     * @title Grid Resolution
     * @description The resolution of the grid.
     * @type {number}
     * @default 2
     */
    set resolution(value) {
        this._resolution = value;
        this._set('uResolution', this._resolution);
    }

    get resolution() {
        return this._resolution;
    }

    destroy() {
        this.entity.removeComponent('render');
    }
}

export { Grid };
