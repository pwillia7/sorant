/**
 * Where every model file the workflows name can be downloaded from.
 *
 * Keyed by the filename the graphs use, which is what ComfyUI matches on. The
 * folder is the one under `models/` that the file's loader reads; the size is
 * Hugging Face's, which is what `models:download` checks a finished file
 * against. `check:workflows` fails when a graph names a file missing from
 * here, so a new workflow cannot ship without saying where its weights come
 * from.
 */
export interface ModelSource {
  repo: string;
  /** Path inside the repo. */
  path: string;
  /** Folder under ComfyUI's `models/`. */
  folder: string;
  bytes: number;
  /** Needs a Hugging Face token from an account that accepted the licence. */
  gated?: true;
}

const H3 = "Comfy-Org/MiniMax-H3";
const MUSIC = "Comfy-Org/MiniMax-Music-3";
const SEEDVR2 = "Comfy-Org/SeedVR2";
const INTERP = "Comfy-Org/frame_interpolation";

export const MODEL_SOURCES: Record<string, ModelSource> = {
  // MiniMax H3
  "minimax_h3_fl2va_pruned_int8_convrot.safetensors": { repo: H3, path: "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", folder: "diffusion_models", bytes: 20970379616 },
  "minimax_h3_ref2va_pruned_int8_convrot.safetensors": { repo: H3, path: "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors", folder: "diffusion_models", bytes: 20970379616 },
  "minimax_h3_ref2va_bf16.safetensors": { repo: H3, path: "diffusion_models/minimax_h3_ref2va_bf16.safetensors", folder: "diffusion_models", bytes: 66280487368 },
  "minimax_h3_fl2va_bf16.safetensors": { repo: H3, path: "diffusion_models/minimax_h3_fl2va_bf16.safetensors", folder: "diffusion_models", bytes: 66280487368 },
  "minimax_h3_fl2va_pruned_fp8_scaled.safetensors": { repo: H3, path: "diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors", folder: "diffusion_models", bytes: 20958205608 },
  "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": { repo: H3, path: "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", folder: "text_encoders", bytes: 15687142551 },
  "qwen3vl_32b_minimax_h3_bf16.safetensors": { repo: H3, path: "text_encoders/qwen3vl_32b_minimax_h3_bf16.safetensors", folder: "text_encoders", bytes: 51506295256 },
  "minimax_h3_video_vae_fp16.safetensors": { repo: H3, path: "vae/minimax_h3_video_vae_fp16.safetensors", folder: "vae", bytes: 5207808496 },
  "minimax_h3_audio_vae_fp32.safetensors": { repo: H3, path: "vae/minimax_h3_audio_vae_fp32.safetensors", folder: "vae", bytes: 605254808 },
  "minimax_h3_turbo_v4_step600_ema.safetensors": { repo: "larryvrh/MiniMax-H3-Turbo-Lora", path: "minimax_h3_turbo_v4_step600_ema.safetensors", folder: "loras", bytes: 779849816 },
  "vh5tape-comfyui.safetensors": { repo: "KennethFal/vh5tape-vhs-lora-minimax-h3", path: "vh5tape-comfyui.safetensors", folder: "loras", bytes: 131242912 },

  // MiniMax Music 3
  "minimax_music3_dit_fp16.safetensors": { repo: MUSIC, path: "diffusion_models/minimax_music3_dit_fp16.safetensors", folder: "diffusion_models", bytes: 4914197682 },
  "minimax_music3_text_encoder_pruned_int8_convrot.safetensors": { repo: MUSIC, path: "text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors", folder: "text_encoders", bytes: 9196611886 },
  "minimax_music3_dav.safetensors": { repo: MUSIC, path: "vae/minimax_music3_dav.safetensors", folder: "vae", bytes: 216696128 },

  // Upscale
  "seedvr2_7b_sharp_int8_convrot.safetensors": { repo: SEEDVR2, path: "diffusion_models/seedvr2_7b_sharp_int8_convrot.safetensors", folder: "diffusion_models", bytes: 8334897976 },
  "seedvr2_3b_int8_convrot.safetensors": { repo: SEEDVR2, path: "diffusion_models/seedvr2_3b_int8_convrot.safetensors", folder: "diffusion_models", bytes: 3458259704 },
  "seedvr2_ema_vae_fp16.safetensors": { repo: SEEDVR2, path: "vae/seedvr2_ema_vae_fp16.safetensors", folder: "vae", bytes: 501324814 },
  "rife_v4.26.safetensors": { repo: INTERP, path: "frame_interpolation/rife_v4.26.safetensors", folder: "frame_interpolation", bytes: 22674688 },
  "film_net_fp16.safetensors": { repo: INTERP, path: "frame_interpolation/film_net_fp16.safetensors", folder: "frame_interpolation", bytes: 68882302 },

  // Edit image (FLUX.1 Kontext dev)
  "flux1-kontext-dev.safetensors": { repo: "black-forest-labs/FLUX.1-Kontext-dev", path: "flux1-kontext-dev.safetensors", folder: "diffusion_models", bytes: 23802947360, gated: true },
  "clip_l.safetensors": { repo: "comfyanonymous/flux_text_encoders", path: "clip_l.safetensors", folder: "text_encoders", bytes: 246144152 },
  "t5xxl_fp8_e4m3fn.safetensors": { repo: "comfyanonymous/flux_text_encoders", path: "t5xxl_fp8_e4m3fn.safetensors", folder: "text_encoders", bytes: 4893934904 },
  "ae.safetensors": { repo: "Comfy-Org/Lumina_Image_2.0_Repackaged", path: "split_files/vae/ae.safetensors", folder: "vae", bytes: 335304388 },

  // The local director (found by pattern, not named in a graph)
  "gemma4_12b_uncensored_heretic_int8_convrot.safetensors": { repo: "radiatingreverberations/Gemma-4-12B-It-Uncensored-Heretic-INT8-ConvRot-ComfyUI", path: "gemma4_12b_uncensored_heretic_int8_convrot.safetensors", folder: "text_encoders", bytes: 12055235716 },
  "Qwen3.8-27B_w4a8.safetensors": { repo: "beycanai/Qwen-LM", path: "Qwen3.8-27B_w4a8.safetensors", folder: "text_encoders", bytes: 17286101500 },
};

/**
 * Downloads no workflow requires, offered by name. Each is either a choice a
 * control makes at run time — so no stored graph names it — or a switch that
 * starts off.
 */
export const EXTRAS: Record<string, { files: string[]; what: string }> = {
  "local-director": {
    files: ["gemma4_12b_uncensored_heretic_int8_convrot.safetensors"],
    what: "rewrite prompts on this machine instead of the gateway: Gemma 4 12B, uncensored and fast, 16 GB cards and up",
  },
  "local-director-27b": {
    files: ["Qwen3.8-27B_w4a8.safetensors"],
    what: "rewrite prompts on this machine with Qwen 3.8 27B: the better writer, twice as slow, 24 GB cards and up",
  },
  "vhs-tape": {
    files: ["vh5tape-comfyui.safetensors", "minimax_h3_fl2va_bf16.safetensors"],
    what: "the VHS tape look, on the bf16 base it needs",
  },
  "vhs-tape-lighter": {
    files: ["vh5tape-comfyui.safetensors", "minimax_h3_fl2va_pruned_fp8_scaled.safetensors"],
    what: "the VHS tape look on the fp8 Lighter base, a third the size of bf16",
  },
  seedvr2: {
    files: ["seedvr2_7b_sharp_int8_convrot.safetensors", "seedvr2_ema_vae_fp16.safetensors"],
    what: "Upscale's SeedVR2 7B upscaler, the slow one that invents detail",
  },
  "upscale-3b": {
    files: ["seedvr2_3b_int8_convrot.safetensors", "seedvr2_ema_vae_fp16.safetensors"],
    what: "Upscale's lighter SeedVR2 3B upscaler",
  },
  film: {
    files: ["film_net_fp16.safetensors"],
    what: "Upscale's FILM frame interpolation",
  },
};
