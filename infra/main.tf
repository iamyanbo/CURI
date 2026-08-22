locals {
  services = toset([
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "firestore.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "aiplatform.googleapis.com",
  ])
}

resource "google_project_service" "apis" {
  for_each           = local.services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

data "google_project" "current" { project_id = var.project_id }

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "autoresearch"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_storage_bucket" "artifacts" {
  name                        = "${var.project_id}-autoresearch-artifacts"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  lifecycle_rule {
    condition { age = 14 }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.apis]
}

resource "google_firestore_database" "state" {
  project                 = var.project_id
  name                    = "(default)"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  depends_on              = [google_project_service.apis]
}

resource "google_service_account" "evaluator" {
  account_id   = "autoresearch-evaluator"
  display_name = "Adversarial Autoresearch protected evaluator"
}

resource "google_storage_bucket_iam_member" "evaluator_artifacts" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.evaluator.email}"
}

resource "google_cloud_run_v2_job" "evaluator" {
  provider            = google-beta
  name                = "autoresearch-evaluator"
  location            = var.region
  deletion_protection = true

  template {
    parallelism = var.gpu_parallelism
    task_count  = 1
    template {
      service_account               = google_service_account.evaluator.email
      timeout                       = "3300s"
      max_retries                   = 0
      gpu_zonal_redundancy_disabled = true
      node_selector { accelerator = "nvidia-l4" }
      containers {
        name  = "evaluator"
        image = var.evaluator_image
        resources {
          limits = {
            cpu              = "4"
            memory           = "16Gi"
            "nvidia.com/gpu" = "1"
          }
        }
      }
    }
  }
  depends_on = [google_project_service.apis, google_storage_bucket_iam_member.evaluator_artifacts]
}

resource "google_billing_budget" "hackathon" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "Adversarial Autoresearch hackathon cap"
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_usd)
    }
  }
  budget_filter { projects = ["projects/${data.google_project.current.number}"] }
  dynamic "threshold_rules" {
    for_each = toset([0.5, 0.8, 1.0])
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }
  depends_on = [google_project_service.apis]
}
