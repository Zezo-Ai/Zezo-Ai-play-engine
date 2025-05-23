export default /* glsl */`

/**
 * PCSS is a shadow sampling method that provides contact hardening soft shadows, used for omni and spot lights.
 * Based on: 
 * - https://www.gamedev.net/tutorials/programming/graphics/effect-area-light-shadows-part-1-pcss-r4971/
 * - https://github.com/pboechat/PCSS 
 */

#define PCSS_SAMPLE_COUNT 16

uniform float pcssDiskSamples[PCSS_SAMPLE_COUNT];
uniform float pcssSphereSamples[PCSS_SAMPLE_COUNT];

vec2 vogelDisk(int sampleIndex, float count, float phi, float r) {
    const float GoldenAngle = 2.4;
    float theta = float(sampleIndex) * GoldenAngle + phi;

    float sine = sin(theta);
    float cosine = cos(theta);
    return vec2(r * cosine, r * sine);
}

vec3 vogelSphere(int sampleIndex, float count, float phi, float r) {
    const float GoldenAngle = 2.4;
    float theta = float(sampleIndex) * GoldenAngle + phi;

    float weight = float(sampleIndex) / count;
    return vec3(cos(theta) * r, weight, sin(theta) * r);
}

float noise(vec2 screenPos) {
    const float PHI = 1.61803398874989484820459;  // Φ = Golden Ratio   
    return fract(sin(dot(screenPos * PHI, screenPos)) * screenPos.x);
}

float viewSpaceDepth(float depth, mat4 invProjection) {
    float z = depth * 2.0 - 1.0;
    vec4 clipSpace = vec4(0.0, 0.0, z, 1.0);
    vec4 viewSpace = invProjection * clipSpace;
    return viewSpace.z;
}

float PCSSBlockerDistance(TEXTURE_ACCEPT(shadowMap), vec2 sampleCoords[PCSS_SAMPLE_COUNT], vec2 shadowCoords, vec2 searchSize, float z, vec4 cameraParams) {

    float blockers = 0.0;
    float averageBlocker = 0.0;
    for (int i = 0; i < PCSS_SAMPLE_COUNT; i++) {
        vec2 offset = sampleCoords[i] * searchSize;
        vec2 sampleUV = shadowCoords + offset;

        float blocker = texture2DLod(shadowMap, sampleUV, 0.0).r;
        float isBlocking = step(blocker, z);
        blockers += isBlocking;
        averageBlocker += blocker * isBlocking;
    }

    if (blockers > 0.0)
        return averageBlocker / blockers;
    return -1.0;
}

float PCSS(TEXTURE_ACCEPT(shadowMap), vec3 shadowCoords, vec4 cameraParams, vec2 shadowSearchArea) {
    float receiverDepth = linearizeDepthWithParams(shadowCoords.z, cameraParams);

    vec2 samplePoints[PCSS_SAMPLE_COUNT];
    const float PI = 3.141592653589793;
    float noise = noise( gl_FragCoord.xy ) * 2.0 * PI;
    for (int i = 0; i < PCSS_SAMPLE_COUNT; i++) {
        float pcssPresample = pcssDiskSamples[i];
        samplePoints[i] = vogelDisk(i, float(PCSS_SAMPLE_COUNT), noise, pcssPresample);
    }

    float averageBlocker = PCSSBlockerDistance(TEXTURE_PASS(shadowMap), samplePoints, shadowCoords.xy, shadowSearchArea, receiverDepth, cameraParams);
    if (averageBlocker == -1.0) {
        return 1.0;
    } else {
        float depthDifference = (receiverDepth - averageBlocker) / 3.0;
        vec2 filterRadius = depthDifference * shadowSearchArea;

        float shadow = 0.0;

        for (int i = 0; i < PCSS_SAMPLE_COUNT; i ++)
        {
            vec2 sampleUV = samplePoints[i] * filterRadius;
            sampleUV = shadowCoords.xy + sampleUV;

            float depth = texture2DLod(shadowMap, sampleUV, 0.0).r;
            shadow += step(receiverDepth, depth);
        }
        return shadow / float(PCSS_SAMPLE_COUNT);
    } 
}

#ifndef WEBGPU

float PCSSCubeBlockerDistance(samplerCube shadowMap, vec3 lightDirNorm, vec3 samplePoints[PCSS_SAMPLE_COUNT], float z, float shadowSearchArea) {
    float blockers = 0.0;
    float averageBlocker = 0.0;
    for (int i = 0; i < PCSS_SAMPLE_COUNT; i++) {
        vec3 sampleDir = lightDirNorm + samplePoints[i] * shadowSearchArea;
        sampleDir = normalize(sampleDir);

        float blocker = textureCubeLod(shadowMap, sampleDir, 0.0).r;
        float isBlocking = step(blocker, z);
        blockers += isBlocking;
        averageBlocker += blocker * isBlocking;
    }

    if (blockers > 0.0)
        return averageBlocker / blockers;
    return -1.0;
}

float PCSSCube(samplerCube shadowMap, vec4 shadowParams, vec3 shadowCoords, vec4 cameraParams, float shadowSearchArea, vec3 lightDir) {
    
    vec3 samplePoints[PCSS_SAMPLE_COUNT];
    const float PI = 3.141592653589793;
    float noise = noise( gl_FragCoord.xy ) * 2.0 * PI;
    for (int i = 0; i < PCSS_SAMPLE_COUNT; i++) {
        float r = pcssSphereSamples[i];
        samplePoints[i] = vogelSphere(i, float(PCSS_SAMPLE_COUNT), noise, r);
    }

    float receiverDepth = length(lightDir) * shadowParams.w + shadowParams.z;
    vec3 lightDirNorm = normalize(lightDir);
    
    float averageBlocker = PCSSCubeBlockerDistance(shadowMap, lightDirNorm, samplePoints, receiverDepth, shadowSearchArea);
    if (averageBlocker == -1.0) {
        return 1.0;
    } else {

        float filterRadius = ((receiverDepth - averageBlocker) / averageBlocker) * shadowSearchArea;

        float shadow = 0.0;
        for (int i = 0; i < PCSS_SAMPLE_COUNT; i++)
        {
            vec3 offset = samplePoints[i] * filterRadius;
            vec3 sampleDir = lightDirNorm + offset;
            sampleDir = normalize(sampleDir);

            float depth = textureCubeLod(shadowMap, sampleDir, 0.0).r;
            shadow += step(receiverDepth, depth);
        }
        return shadow / float(PCSS_SAMPLE_COUNT);
    }
}

float getShadowOmniPCSS(samplerCube shadowMap, vec3 shadowCoord, vec4 shadowParams, vec4 cameraParams, vec2 shadowSearchArea, vec3 lightDir) {
    return PCSSCube(shadowMap, shadowParams, shadowCoord, cameraParams, shadowSearchArea.x, lightDir);
}

#endif

float getShadowSpotPCSS(TEXTURE_ACCEPT(shadowMap), vec3 shadowCoord, vec4 shadowParams, vec4 cameraParams, vec2 shadowSearchArea, vec3 lightDir) {
    return PCSS(TEXTURE_PASS(shadowMap), shadowCoord, cameraParams, shadowSearchArea);
}

`;
