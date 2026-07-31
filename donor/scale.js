import { createHash } from "node:crypto";

export const SCALE_CONTRACT_VERSION = "mvl.scale/0.1.0";

const SCALE_MODES = new Set([
  "camera_height",
  "trajectory",
  "metric_model",
  "known_object",
  "oracle_reference",
]);

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON requires finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertPositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be positive`);
  }
}

function assertNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be non-negative`);
  }
}

function assertProvenance(provenance) {
  if (provenance === null || typeof provenance !== "object") {
    throw new TypeError("scale solver provenance must be an object");
  }
  assertNonEmptyString(provenance.code_revision, "code_revision");
  if (!Number.isInteger(provenance.seed) || provenance.seed < 0) {
    throw new RangeError("seed must be a non-negative integer");
  }
}

function orderedObservations(observations, validator) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new TypeError("scale solver requires at least one observation");
  }
  const ids = new Set();
  for (const observation of observations) {
    if (observation === null || typeof observation !== "object") {
      throw new TypeError("each scale observation must be an object");
    }
    assertNonEmptyString(
      observation.observation_id,
      "observation_id",
    );
    if (ids.has(observation.observation_id)) {
      throw new TypeError("observation_id values must be unique");
    }
    ids.add(observation.observation_id);
    validator(observation);
  }
  return [...observations].sort((left, right) =>
    compareText(left.observation_id, right.observation_id),
  );
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) {
    return ordered[midpoint];
  }
  return (ordered[midpoint - 1] + ordered[midpoint]) / 2;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const mean =
    values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) /
      (values.length - 1),
  );
}

function residualSummary(residuals) {
  return {
    unit: "metre",
    rmse_m: Math.sqrt(
      residuals.reduce(
        (sum, residual) => sum + residual ** 2,
        0,
      ) / residuals.length,
    ),
    max_abs_m: Math.max(
      ...residuals.map((residual) => Math.abs(residual)),
    ),
  };
}

function cameraHeightScale(request) {
  assertPositive(
    request.known_camera_height_m,
    "known_camera_height_m",
  );
  assertNonNegative(
    request.known_camera_height_uncertainty_m,
    "known_camera_height_uncertainty_m",
  );
  const observations = orderedObservations(
    request.observations,
    (observation) =>
      assertPositive(
        observation.predicted_height_units,
        "predicted_height_units",
      ),
  );
  const predictedHeights = observations.map(
    ({ predicted_height_units: height }) => height,
  );
  const factor =
    request.known_camera_height_m / median(predictedHeights);
  const scaleEstimates = predictedHeights.map(
    (height) => request.known_camera_height_m / height,
  );
  const observationSem =
    sampleStandardDeviation(scaleEstimates) /
    Math.sqrt(scaleEstimates.length);
  const calibrationContribution =
    factor *
    (request.known_camera_height_uncertainty_m /
      request.known_camera_height_m);
  return {
    mode: "camera_height",
    factor,
    factor_unit: "metre_per_model_unit",
    support: {
      kind: "ground_distance_observations",
      observation_count: observations.length,
      observation_ids: observations.map(
        ({ observation_id: observationId }) => observationId,
      ),
      known_camera_height_m: request.known_camera_height_m,
    },
    residual: residualSummary(
      predictedHeights.map(
        (height) =>
          height * factor - request.known_camera_height_m,
      ),
    ),
    uncertainty: {
      method: "calibration_and_observation_standard_error",
      factor_standard_uncertainty: Math.hypot(
        calibrationContribution,
        observationSem,
      ),
    },
    reference_access: {
      policy: "forbidden",
      accessed: false,
    },
  };
}

function regressionScale({
  mode,
  observations,
  predictedKey,
  metricKey,
  uncertaintyKey,
  supportKind,
  referenceAccess,
}) {
  const ordered = orderedObservations(observations, (observation) => {
    assertPositive(observation[predictedKey], predictedKey);
    assertPositive(observation[metricKey], metricKey);
    assertNonNegative(observation[uncertaintyKey], uncertaintyKey);
  });
  const denominator = ordered.reduce(
    (sum, observation) =>
      sum + observation[predictedKey] ** 2,
    0,
  );
  const factor =
    ordered.reduce(
      (sum, observation) =>
        sum +
        observation[predictedKey] * observation[metricKey],
      0,
    ) / denominator;
  const residuals = ordered.map(
    (observation) =>
      observation[predictedKey] * factor -
      observation[metricKey],
  );
  const residualVariance =
    residuals.reduce(
      (sum, residual) => sum + residual ** 2,
      0,
    ) / Math.max(1, ordered.length - 1);
  const fitUncertainty = Math.sqrt(
    residualVariance / denominator,
  );
  const measurementUncertainty = Math.sqrt(
    ordered.reduce(
      (sum, observation) =>
        sum +
        (observation[uncertaintyKey] /
          observation[predictedKey]) **
          2,
      0,
    ),
  ) / ordered.length;
  return {
    mode,
    factor,
    factor_unit: "metre_per_model_unit",
    support: {
      kind: supportKind,
      observation_count: ordered.length,
      observation_ids: ordered.map(
        ({ observation_id: observationId }) => observationId,
      ),
      predicted_distance_sum_units: ordered.reduce(
        (sum, observation) => sum + observation[predictedKey],
        0,
      ),
      metric_distance_sum_m: ordered.reduce(
        (sum, observation) => sum + observation[metricKey],
        0,
      ),
    },
    residual: residualSummary(residuals),
    uncertainty: {
      method: "through_origin_fit_and_measurement_uncertainty",
      factor_standard_uncertainty: Math.hypot(
        fitUncertainty,
        measurementUncertainty,
      ),
    },
    reference_access: referenceAccess,
  };
}

function trajectoryScale(request) {
  return regressionScale({
    mode: "trajectory",
    observations: request.observations,
    predictedKey: "predicted_distance_units",
    metricKey: "metric_distance_m",
    uncertaintyKey: "metric_uncertainty_m",
    supportKind: "metric_trajectory_displacements",
    referenceAccess: {
      policy: "forbidden",
      accessed: false,
    },
  });
}

function metricModelScale(request) {
  assertNonEmptyString(request.model_id, "model_id");
  assertNonEmptyString(request.model_version, "model_version");
  if (request.output_linear_unit !== "metre") {
    throw new TypeError(
      "metric_model output_linear_unit must be metre",
    );
  }
  assertNonNegative(
    request.reported_relative_uncertainty,
    "reported_relative_uncertainty",
  );
  return {
    mode: "metric_model",
    factor: 1,
    factor_unit: "unitless",
    support: {
      kind: "metric_model_declaration",
      observation_count: 1,
      observation_ids: [
        `${request.model_id}@${request.model_version}`,
      ],
      model_id: request.model_id,
      model_version: request.model_version,
    },
    residual: residualSummary([0]),
    uncertainty: {
      method: "model_reported_relative_uncertainty",
      factor_standard_uncertainty:
        request.reported_relative_uncertainty,
    },
    reference_access: {
      policy: "forbidden",
      accessed: false,
    },
  };
}

function knownObjectScale(request) {
  assertNonEmptyString(request.object_id, "object_id");
  assertPositive(request.known_size_m, "known_size_m");
  assertNonNegative(
    request.known_size_uncertainty_m,
    "known_size_uncertainty_m",
  );
  assertPositive(
    request.predicted_size_units,
    "predicted_size_units",
  );
  const factor =
    request.known_size_m / request.predicted_size_units;
  return {
    mode: "known_object",
    factor,
    factor_unit: "metre_per_model_unit",
    support: {
      kind: "identified_known_object",
      observation_count: 1,
      observation_ids: [request.object_id],
      known_size_m: request.known_size_m,
    },
    residual: residualSummary([0]),
    uncertainty: {
      method: "known_object_measurement_uncertainty",
      factor_standard_uncertainty:
        request.known_size_uncertainty_m /
        request.predicted_size_units,
    },
    reference_access: {
      policy: "forbidden",
      accessed: false,
    },
  };
}

function oracleReferenceScale(request) {
  if (
    request.reference_geometry === null ||
    typeof request.reference_geometry !== "object"
  ) {
    throw new TypeError(
      "oracle_reference requires reference_geometry",
    );
  }
  const sourceId = request.reference_geometry.source_id;
  assertNonEmptyString(sourceId, "reference_geometry.source_id");
  const observations = request.reference_geometry.observations;
  return regressionScale({
    mode: "oracle_reference",
    observations,
    predictedKey: "predicted_distance_units",
    metricKey: "reference_distance_m",
    uncertaintyKey: "reference_uncertainty_m",
    supportKind: "oracle_reference_geometry",
    referenceAccess: {
      policy: "oracle_only",
      accessed: true,
      source_id: sourceId,
    },
  });
}

export function solveScale(request, provenance) {
  if (request === null || typeof request !== "object") {
    throw new TypeError("scale request must be an object");
  }
  if (!SCALE_MODES.has(request.mode)) {
    throw new RangeError(`unsupported scale mode: ${request.mode}`);
  }
  assertProvenance(provenance);

  let solution;
  switch (request.mode) {
    case "camera_height":
      solution = cameraHeightScale(request);
      break;
    case "trajectory":
      solution = trajectoryScale(request);
      break;
    case "metric_model":
      solution = metricModelScale(request);
      break;
    case "known_object":
      solution = knownObjectScale(request);
      break;
    case "oracle_reference":
      solution = oracleReferenceScale(request);
      break;
  }

  const artifact = {
    scale_contract_version: SCALE_CONTRACT_VERSION,
    ...solution,
    input_linear_unit:
      solution.factor_unit === "unitless" ? "metre" : "model_unit",
    output_linear_unit: "metre",
    producer: {
      producer_node: "explicit-scale-solver",
      producer_version: SCALE_CONTRACT_VERSION,
      code_revision: provenance.code_revision,
      seed: provenance.seed,
    },
  };
  return {
    ...artifact,
    content_sha256: canonicalSha256(artifact),
  };
}
