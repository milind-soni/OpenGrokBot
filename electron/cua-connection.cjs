const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

function createCuaConnectionStore({
  getUserData,
  fileSystem = fs,
  temporaryId = randomUUID,
  processId = process.pid,
}) {
  let connection = null;

  return Object.freeze({
    get() {
      return connection;
    },

    persist(next) {
      const userData = getUserData();
      fileSystem.mkdirSync(userData, { recursive: true });
      const descriptorPath = path.join(userData, "cua-connection.json");
      const temporaryPath = `${descriptorPath}.${processId}.${temporaryId()}.tmp`;

      try {
        fileSystem.writeFileSync(temporaryPath, JSON.stringify(next, null, 2));
        fileSystem.renameSync(temporaryPath, descriptorPath);
      } catch (error) {
        try {
          fileSystem.unlinkSync(temporaryPath);
        } catch {
          // The temporary file may not have been created or may already be renamed.
        }
        throw error;
      }

      connection = next;
      return connection;
    },
  });
}

module.exports = { createCuaConnectionStore };
