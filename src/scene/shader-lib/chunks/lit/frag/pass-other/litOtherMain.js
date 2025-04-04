// main shader entry point for the lit material for other render passes
export default /* glsl */`

#ifdef PICK_PASS
    #include "pickPS"
#endif

#ifdef PREPASS_PASS
    #include "floatAsUintPS"
#endif

void main(void) {
    evaluateFrontend();

    #ifdef PICK_PASS
        gl_FragColor = getPickOutput();
    #endif

    #ifdef DEPTH_PASS
        gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    #endif

    #ifdef PREPASS_PASS
        gl_FragColor = float2vec4(vLinearDepth);
    #endif
}
`;
