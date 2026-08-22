variable "project_id" {
  description = "A dedicated, already-created Google Cloud project. Never point this at an unrelated project."
  type        = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "evaluator_image" {
  description = "Immutable evaluator image digest, e.g. us-central1-docker.pkg.dev/PROJECT/autoresearch/evaluator@sha256:..."
  type        = string
  validation {
    condition     = strcontains(var.evaluator_image, "@sha256:")
    error_message = "Use an immutable image digest, not a mutable tag."
  }
}

variable "billing_account" {
  description = "Billing account ID used only to create the $25 alert budget. Leave empty to skip it."
  type        = string
  default     = ""
  sensitive   = true
}

variable "budget_usd" {
  type    = number
  default = 25
}

variable "gpu_parallelism" {
  description = "Keep at or below the granted no-zonal-redundancy L4 quota."
  type        = number
  default     = 3
  validation {
    condition     = var.gpu_parallelism >= 1 && var.gpu_parallelism <= 3
    error_message = "Hackathon configuration is capped at 1-3 concurrent L4 tasks."
  }
}
