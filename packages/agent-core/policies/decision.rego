# The tool gate every agentdesk bot's tool calls pass through.
#
# Ported from sourceplane/ai-slackbot (baseline-v3), itself a port of
# vercel-labs/ai-sdk-slackbot (MIT). What changed for a multi-tenant product:
# the bot's GRANTS arrive in the input and are the first gate — a tool no
# grant names is denied, whoever's bot it is — and the demo restrictions that
# were hard-coded for one Slack workspace (the city list, the vercel.com
# search domain, the dice channel) became argument constraints on the grant.
# The bash and file-access safety rules are upstream's, unchanged.
#
# Compiled to WASM with:
#   opa build -t wasm -e 'agent/call/decision' -o policies/bundle.tar.gz policies/decision.rego
#   tar -xzf policies/bundle.tar.gz -C policies/ /policy.wasm
#
# Input shape (set by @ai-sdk/policy-opa through toInput in src/policy/load.ts):
#   {
#     "tool":    { "name": <string> },
#     "args":    <tool input>,
#     "messages":[...],
#     "runtimeContext": {
#       "orgId", "projectId", "channelId", "userId",
#       "grants": { "<tool name>": { "mode": "allow" | "approve" | "deny",
#                                    "argConstraints": { "<arg>": "<glob>" } } }
#     },
#     # Only for the bash tool, added by toInput:
#     "bash":    { "program": <string>, "argv": [<string>], "suspicious": <bool> }
#   }
#
# Decision shape (consumed by normalizeOpaDecision):
#   { "decision": "allow" | "deny" | "requires-approval",
#     "reason":   <optional string surfaced to the model/user> }

package agent.call

import rego.v1

# ---------------------------------------------------------------------------
# Configuration — upstream's bash allowlist, unchanged.
#
# Do NOT add commands that can launch or sequence other programs (env, find,
# xargs, sh, bash, awk, sed, python, ...): the policy gates on the program name
# (argv[0]) only, so a launcher would run an unlisted program past the gate.
# ---------------------------------------------------------------------------

allowed_bash_commands := {
	"echo", "ls", "cat", "pwd", "date", "whoami", "head", "tail", "wc",
	"grep", "sort", "uniq", "tree", "printf", "seq",
	"stat", "which", "basename", "dirname",
}

builtin_tools := {"getWeather", "searchWeb", "throwDice", "bash", "readFile", "writeFile"}

# ---------------------------------------------------------------------------
# Top-level entrypoint. Default-deny.
# ---------------------------------------------------------------------------

default decision := {"decision": "deny", "reason": "This tool is not permitted by policy."}

# 1. No grant, or a deny grant: refused, with the reason the admin would want.
decision := {"decision": "deny", "reason": sprintf("%s is not granted to this bot.", [input.tool.name])} if {
	not grant
}

decision := {"decision": "deny", "reason": sprintf("%s is denied for this bot.", [input.tool.name])} if {
	grant.mode == "deny"
}

# 2. A granted call whose arguments break the grant's constraints.
decision := {"decision": "deny", "reason": constraint_reason} if {
	grant.mode in {"allow", "approve"}
	constraint_violated
}

# 3. Granted, within constraints, ask-first: the runtime asks a human.
decision := {"decision": "requires-approval", "reason": sprintf("%s needs approval before it runs.", [input.tool.name])} if {
	grant.mode == "approve"
	not constraint_violated
	builtin_ok
}

# 4. Granted, within constraints, allowed — and, for a built-in, its own
#    safety rule agrees.
decision := {"decision": "allow"} if {
	grant.mode == "allow"
	not constraint_violated
	builtin_ok
}

# A built-in's safety rule refused: that reason wins over the grant.
decision := builtin_decision if {
	grant.mode in {"allow", "approve"}
	not constraint_violated
	not builtin_ok
}

grant := input.runtimeContext.grants[input.tool.name]

# ---------------------------------------------------------------------------
# Argument constraints: { "<arg>": "<glob>" }, every one must match the
# argument's string value (case-insensitive). A missing or non-string argument
# fails its constraint.
# ---------------------------------------------------------------------------

violations := {arg |
	some arg, pattern in object.get(grant, "argConstraints", {})
	not arg_matches(arg, pattern)
}

constraint_violated if count(violations) > 0

arg_matches(arg, pattern) if {
	value := input.args[arg]
	is_string(value)
	glob.match(lower(pattern), [], lower(trim_space(value)))
}

# One reason, for the first violated argument in name order: a complete rule
# may only produce one value.
constraint_reason := sprintf("%s: argument `%s` is outside what this bot may use (%s).", [input.tool.name, arg, grant.argConstraints[arg]]) if {
	arg := sort(violations)[0]
}

# ---------------------------------------------------------------------------
# Built-in safety rules (upstream's bash and file rules). Tools that are not
# built-ins — MCP tools — have no extra rule: the grant decides.
# ---------------------------------------------------------------------------

builtin_ok if not input.tool.name in builtin_tools

builtin_ok if builtin_decision.decision == "allow"

builtin_decision := {"decision": "allow"} if input.tool.name in {"getWeather", "searchWeb", "throwDice"}

builtin_decision := bash_decision if input.tool.name == "bash"

builtin_decision := read_file_decision if input.tool.name == "readFile"

builtin_decision := write_file_decision if input.tool.name == "writeFile"

bash_decision := {"decision": "allow"} if {
	not input.bash.suspicious
	input.bash.program in allowed_bash_commands
	not bash_arg_escapes_workspace
} else := {"decision": "deny", "reason": bash_deny_reason}

bash_deny_reason := "Only a single, simple command is allowed (no pipes, redirects, chaining, or variable assignments)." if input.bash.suspicious

bash_deny_reason := sprintf(
	"`%s` is not an allowed command. Allowed: %s.",
	[input.bash.program, concat(", ", sort(allowed_bash_commands))],
) if {
	not input.bash.suspicious
	not input.bash.program in allowed_bash_commands
}

bash_deny_reason := "Commands may only reference relative paths within the workspace." if {
	not input.bash.suspicious
	input.bash.program in allowed_bash_commands
	bash_arg_escapes_workspace
}

bash_arg_escapes_workspace if {
	some arg in input.bash.argv
	path_escapes_workspace(arg)
}

path_escapes_workspace(p) if startswith(p, "/")

path_escapes_workspace(p) if contains(p, "..")

# The bot is read-only: writeFile is always denied; readFile only relative,
# non-traversing paths.
write_file_decision := {
	"decision": "deny",
	"reason": "This bot is read-only; writing files is not permitted.",
}

read_file_decision := {"decision": "allow"} if {
	is_string(input.args.path)
	not path_escapes_workspace(input.args.path)
} else := {
	"decision": "deny",
	"reason": "Only relative paths within the workspace can be read.",
}
