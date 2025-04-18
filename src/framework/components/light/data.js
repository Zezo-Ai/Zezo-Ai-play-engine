import { Color } from '../../../core/math/color.js';
import {
    BLUR_GAUSSIAN,
    LAYERID_WORLD,
    LIGHTSHAPE_PUNCTUAL,
    LIGHTFALLOFF_LINEAR,
    SHADOW_PCF3_32F,
    SHADOWUPDATE_REALTIME
} from '../../../scene/constants.js';

/**
 * @import { Light } from '../../../scene/light.js'
 */

class LightComponentData {
    enabled = true;

    /** @type {Light} */
    light;

    type = 'directional';

    color = new Color(1, 1, 1);

    intensity = 1;

    luminance = 0;

    shape = LIGHTSHAPE_PUNCTUAL;

    affectSpecularity = true;

    castShadows = false;

    shadowDistance = 40;

    shadowIntensity = 1;

    shadowResolution = 1024;

    shadowBias = 0.05;

    numCascades = 1;

    cascadeBlend = 0;

    bakeNumSamples = 1;

    bakeArea = 0;

    cascadeDistribution = 0.5;

    normalOffsetBias = 0;

    range = 10;

    innerConeAngle = 40;

    outerConeAngle = 45;

    falloffMode = LIGHTFALLOFF_LINEAR;

    shadowType = SHADOW_PCF3_32F;

    vsmBlurSize = 11;

    vsmBlurMode = BLUR_GAUSSIAN;

    vsmBias = 0.01 * 0.25;

    cookieAsset = null;

    cookie = null;

    cookieIntensity = 1;

    cookieFalloff = true;

    cookieChannel = 'rgb';

    cookieAngle = 0;

    cookieScale = null;

    cookieOffset = null;

    shadowUpdateMode = SHADOWUPDATE_REALTIME;

    mask = 1;

    affectDynamic = true;

    affectLightmapped = false;

    bake = false;

    bakeDir = true;

    isStatic = false;

    layers = [LAYERID_WORLD];

    penumbraSize = 1;

    penumbraFalloff = 1;

    shadowSamples = 16;

    shadowBlockerSamples = 16;
}

const properties = Object.keys(new LightComponentData());

export { properties, LightComponentData };
