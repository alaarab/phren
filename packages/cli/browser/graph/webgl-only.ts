/** iOS build replacement for the optional, unused three/webgpu backend.
 * Fail explicitly if a future renderer enables WebGPU without changing the
 * build. The existing WebGL renderer and bloom composer remain untouched. */
export class WebGPURenderer {
  constructor() {
    throw new Error("The Phren iOS graph bundle supports WebGL only.");
  }
}
