import { createHash } from "node:crypto";

import {
  GEOMETRY_ADAPTER_CONTRACT_VERSION,
  assertGeometryAdapterDescriptor,
} from "../../../packages/contracts/src/geometry-adapter.js";

const DA3_REPOSITORY = Object.freeze({
  url: "https://github.com/ByteDance-Seed/Depth-Anything-3",
  revision: "3d835ec1a5802d64a8b8b15f817a1ab54809bfe4",
  revision_url:
    "https://github.com/ByteDance-Seed/Depth-Anything-3/commit/3d835ec1a5802d64a8b8b15f817a1ab54809bfe4",
});

const GITHUB_MODEL_TABLE =
  "https://github.com/ByteDance-Seed/Depth-Anything-3/blob/3d835ec1a5802d64a8b8b15f817a1ab54809bfe4/README.md#%EF%B8%8F-model-cards";

const COMMON_DEPTH_CAPABILITY = Object.freeze({
  frame: "camera_opencv",
  parent_frame: "rig",
  transform_convention: "p_rig=T_rig_camera*p_camera",
});

const COMMON_POSE_CAPABILITY = Object.freeze({
  frame: "world_enu",
  parent_frame: null,
  rotation_unit: "radian",
  transform_convention: "p_world=T_world_camera*p_camera",
});

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function createDescriptor(identity) {
  const descriptorWithoutChecksum = {
    contract_version: GEOMETRY_ADAPTER_CONTRACT_VERSION,
    adapter_id: identity.adapter_id,
    adapter_version: "0.1.0",
    execution_kind: "remote_worker",
    source: {
      source_id: identity.source_id,
      source_version: identity.model.revision,
      source_checksum: identity.checkpoint.sha256,
      licence: {
        identifier: identity.licence_review.effective_identifier,
        class: identity.licence_review.effective_class,
      },
    },
    capabilities: identity.capabilities,
    repository: DA3_REPOSITORY,
    model: identity.model,
    checkpoint: identity.checkpoint,
    licence_review: identity.licence_review,
  };
  const descriptor = {
    ...descriptorWithoutChecksum,
    adapter_checksum: sha256(canonicalJson(descriptorWithoutChecksum)),
  };
  assertGeometryAdapterDescriptor(descriptor);
  return deepFreeze(descriptor);
}

function huggingFaceSource(modelName, revision, declaredIdentifier) {
  return Object.freeze({
    authority: "official_hugging_face_model_metadata",
    url: `https://huggingface.co/depth-anything/${modelName}/tree/${revision}`,
    revision,
    declared_identifier: declaredIdentifier,
  });
}

function githubSource(declaredIdentifier) {
  return Object.freeze({
    authority: "official_bytedance_repository_model_table",
    url: GITHUB_MODEL_TABLE,
    revision: DA3_REPOSITORY.revision,
    declared_identifier: declaredIdentifier,
  });
}

const METRIC_MODEL = Object.freeze({
  repository_id: "depth-anything/DA3METRIC-LARGE",
  revision: "4010e39f3634a45bc60553321fb49fb760bd594e",
  url: "https://huggingface.co/depth-anything/DA3METRIC-LARGE",
});

const SMALL_MODEL = Object.freeze({
  repository_id: "depth-anything/DA3-SMALL",
  revision: "e08cab65ca0ec38e7826075418411ab90cab4da3",
  url: "https://huggingface.co/depth-anything/DA3-SMALL",
});

const LARGE_1_1_MODEL = Object.freeze({
  repository_id: "depth-anything/DA3-LARGE-1.1",
  revision: "0e109ae307c5982f319a67cf6f9f99ccdc0ec97c",
  url: "https://huggingface.co/depth-anything/DA3-LARGE-1.1",
});

const NESTED_GIANT_LARGE_1_1_MODEL = Object.freeze({
  repository_id: "depth-anything/DA3NESTED-GIANT-LARGE-1.1",
  revision: "b2359bdf726fb44ef62acca04d629dcf158053e7",
  url: "https://huggingface.co/depth-anything/DA3NESTED-GIANT-LARGE-1.1",
});

export const DA3_MODEL_DESCRIPTORS = deepFreeze({
  da3metric_large: createDescriptor({
    adapter_id: "da3.metric-large",
    source_id: "MODEL-DA3-METRIC-LARGE",
    model: METRIC_MODEL,
    checkpoint: {
      filename: "model.safetensors",
      sha256:
        "bbea5b0b3ee389849cffa7ddae89de064a90abd2b055fc5aa99aac68db324776",
      size_bytes: 1_336_734_448,
    },
    licence_review: {
      conflict: false,
      effective_identifier: "Apache-2.0",
      effective_class: "commercial",
      commercial_eligibility_claimed: true,
      official_sources: [
        githubSource("Apache-2.0"),
        huggingFaceSource(
          "DA3METRIC-LARGE",
          METRIC_MODEL.revision,
          "Apache-2.0",
        ),
      ],
    },
    capabilities: {
      depth: {
        mode: "metric",
        ...COMMON_DEPTH_CAPABILITY,
        value_unit: "metre",
      },
      pose: {
        mode: "input_required",
        ...COMMON_POSE_CAPABILITY,
        translation_unit: "metre",
      },
    },
  }),
  da3_small: createDescriptor({
    adapter_id: "da3.small",
    source_id: "MODEL-DA3-SMALL",
    model: SMALL_MODEL,
    checkpoint: {
      filename: "model.safetensors",
      sha256:
        "364492e38a3a06d221ac75da7f6621ada3f2361cd24fde11ba79091e9f40efcf",
      size_bytes: 137_248_940,
    },
    licence_review: {
      conflict: false,
      effective_identifier: "Apache-2.0",
      effective_class: "commercial",
      commercial_eligibility_claimed: true,
      official_sources: [
        githubSource("Apache-2.0"),
        huggingFaceSource(
          "DA3-SMALL",
          SMALL_MODEL.revision,
          "Apache-2.0",
        ),
      ],
    },
    capabilities: {
      depth: {
        mode: "relative",
        ...COMMON_DEPTH_CAPABILITY,
        value_unit: "relative_scale",
      },
      pose: {
        mode: "estimated",
        ...COMMON_POSE_CAPABILITY,
        translation_unit: "relative_scale",
      },
    },
  }),
  da3_large_1_1: createDescriptor({
    adapter_id: "da3.large-1.1.academic",
    source_id: "MODEL-DA3-LARGE-1.1",
    model: LARGE_1_1_MODEL,
    checkpoint: {
      filename: "model.safetensors",
      sha256:
        "739905c423cf0d6ccaf9e61a8401d82ba1ac32d7f4d3ee6dca8f92b377633f64",
      size_bytes: 1_643_843_860,
    },
    licence_review: {
      conflict: true,
      resolution:
        "apply_more_restrictive_official_declaration_for_academic_poc_only",
      effective_identifier: "CC-BY-NC-4.0",
      effective_class: "non_commercial",
      commercial_eligibility_claimed: false,
      official_sources: [
        githubSource("CC-BY-NC-4.0"),
        huggingFaceSource(
          "DA3-LARGE-1.1",
          LARGE_1_1_MODEL.revision,
          "Apache-2.0",
        ),
      ],
    },
    capabilities: {
      depth: {
        mode: "relative",
        ...COMMON_DEPTH_CAPABILITY,
        value_unit: "relative_scale",
      },
      pose: {
        mode: "estimated",
        ...COMMON_POSE_CAPABILITY,
        translation_unit: "relative_scale",
      },
    },
  }),
  da3_nested_giant_large_1_1: createDescriptor({
    adapter_id: "da3.nested-giant-large-1.1.academic",
    source_id: "MODEL-DA3-NESTED-1.1",
    model: NESTED_GIANT_LARGE_1_1_MODEL,
    checkpoint: {
      filename: "model.safetensors",
      sha256:
        "8ebe871a022ed58d2fc8fdfb2ebdb31d57b60fe39611c849095851a7b7c6020c",
      size_bytes: 6_759_558_100,
    },
    licence_review: {
      conflict: false,
      effective_identifier: "CC-BY-NC-4.0",
      effective_class: "non_commercial",
      commercial_eligibility_claimed: false,
      official_sources: [
        githubSource("CC-BY-NC-4.0"),
        huggingFaceSource(
          "DA3NESTED-GIANT-LARGE-1.1",
          NESTED_GIANT_LARGE_1_1_MODEL.revision,
          "CC-BY-NC-4.0",
        ),
      ],
    },
    capabilities: {
      depth: {
        mode: "metric",
        ...COMMON_DEPTH_CAPABILITY,
        value_unit: "metre",
      },
      pose: {
        mode: "estimated",
        ...COMMON_POSE_CAPABILITY,
        translation_unit: "metre",
      },
    },
  }),
});

export const DA3_PITCH_CANDIDATES = Object.freeze([
  "da3_large_1_1",
  "da3_nested_giant_large_1_1",
]);

export const DA3_PROFILE_SELECTIONS = deepFreeze({
  academic_poc: {
    primary_any_view: "da3_large_1_1",
    fallback_any_view: "da3_small",
    metric_diagnostic: "da3metric_large",
  },
});

export function createDa3Adapter(descriptor, executeRemote) {
  assertGeometryAdapterDescriptor(descriptor);
  if (typeof executeRemote !== "function") {
    throw new TypeError("executeRemote must be a function");
  }
  return Object.freeze({
    descriptor,
    execute(request) {
      return executeRemote(request, descriptor);
    },
  });
}

export function assertModelEligibleForRunProfile({
  descriptor,
  run_profile,
}) {
  assertGeometryAdapterDescriptor(descriptor);
  if (run_profile === "production") {
    if (descriptor.source.licence.class !== "commercial") {
      throw new Error(
        `${descriptor.source.source_id} is not eligible for production: ${descriptor.source.licence.class}`,
      );
    }
    return;
  }
  if (run_profile !== "academic_poc") {
    throw new Error(
      `${run_profile} is not an explicitly permitted restricted-model run profile`,
    );
  }
  if (
    !["commercial", "non_commercial", "research_only"].includes(
      descriptor.source.licence.class,
    )
  ) {
    throw new Error(
      `${descriptor.source.source_id} is not eligible for academic_poc: ${descriptor.source.licence.class}`,
    );
  }
}

export async function allocateAfterModelLicencePreflight({
  descriptor,
  run_profile,
  allocate_worker,
}) {
  if (typeof allocate_worker !== "function") {
    throw new TypeError("allocate_worker must be a function");
  }
  assertModelEligibleForRunProfile({ descriptor, run_profile });
  return allocate_worker();
}
