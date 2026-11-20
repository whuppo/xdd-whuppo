// Where tools load generated data from. Include before a tool's own script:
//   <script src="../config.js"></script>   then fetch(`${window.XDD_DATA}/...`)
//
// Production data lives in S3 behind CloudFront (written by the updater Lambda, infra/updater.yml).
// The Pages deploy replaces __DATA_URL__ with the DATA_URL repository variable.
// Locally, server.py serves the same files at /data, next to this script.
(() => {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  window.XDD_DATA = local ? new URL("data", document.currentScript.src).href : "__DATA_URL__";
})();
