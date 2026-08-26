/**
 * Entry point for the hosted mirror.
 *
 * Deliberately separate from the CLI: importing the CLI would pull in the local
 * SQLite store, the worker and the supervisor, none of which the public mirror
 * may touch. This process can only read Firestore and serve the page.
 */

import { serveMirror } from "./mirror.js";

await serveMirror({
  // Cloud Run supplies the port it expects the container to listen on.
  port: Number(process.env.PORT ?? 8080),
  directionId: process.env.AR_DIRECTION,
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  databaseId: process.env.AR_FIRESTORE_DATABASE,
});
