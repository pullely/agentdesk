// What `import … from "just-bash"` resolves to inside the Worker
// (wrangler.template.jsonc → alias), ported from sourceplane/ai-slackbot:
// the browser build of just-bash (the Node build needs worker_threads and
// native addons a Worker cannot run). bash-tool imports two classes the
// browser build lacks, used only by its opt-in experimentalTeeTransform,
// which agentdesk never turns on — so they are stubs that refuse loudly.
export * from "../../node_modules/just-bash/dist/bundle/browser.js";

class NotInTheBrowserBuild {
  constructor() {
    throw new Error("just-bash's transform plugins are not in its browser build, the one a Worker runs");
  }
}
export class BashTransformPipeline extends NotInTheBrowserBuild {}
export class TeePlugin extends NotInTheBrowserBuild {}
