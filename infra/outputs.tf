output "artifact_bucket" { value = google_storage_bucket.artifacts.name }
output "evaluator_job" { value = google_cloud_run_v2_job.evaluator.name }
output "artifact_repository" { value = google_artifact_registry_repository.images.name }
