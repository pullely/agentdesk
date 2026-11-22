package agent.call_test

import rego.v1

import data.agent.call

grants_allow(name) := {"grants": {name: {"mode": "allow"}}}

# ---------- grants: the first gate ----------

test_ungranted_tool_denied if {
	d := call.decision with input as {"tool": {"name": "mcp__linear__create_issue"}, "args": {}, "runtimeContext": {"grants": {}}}
	d.decision == "deny"
	contains(d.reason, "not granted")
}

test_no_runtime_context_denied if {
	d := call.decision with input as {"tool": {"name": "throwDice"}, "args": {}}
	d.decision == "deny"
}

test_deny_grant_denied if {
	d := call.decision with input as {"tool": {"name": "mcp__gh__delete_repo"}, "args": {}, "runtimeContext": {"grants": {"mcp__gh__delete_repo": {"mode": "deny"}}}}
	d.decision == "deny"
	contains(d.reason, "denied for this bot")
}

test_allow_grant_mcp_allowed if {
	call.decision.decision == "allow" with input as {"tool": {"name": "mcp__docs__search"}, "args": {"q": "x"}, "runtimeContext": grants_allow("mcp__docs__search")}
}

test_approve_grant_requires_approval if {
	d := call.decision with input as {"tool": {"name": "mcp__gh__create_issue"}, "args": {"repo": "acme/web"}, "runtimeContext": {"grants": {"mcp__gh__create_issue": {"mode": "approve"}}}}
	d.decision == "requires-approval"
}

# ---------- argument constraints ----------

test_constraint_match_allowed if {
	call.decision.decision == "allow" with input as {
		"tool": {"name": "mcp__gh__get_issue"},
		"args": {"repo": "Acme/web"},
		"runtimeContext": {"grants": {"mcp__gh__get_issue": {"mode": "allow", "argConstraints": {"repo": "acme/*"}}}},
	}
}

test_constraint_mismatch_denied if {
	d := call.decision with input as {
		"tool": {"name": "mcp__gh__get_issue"},
		"args": {"repo": "evil/web"},
		"runtimeContext": {"grants": {"mcp__gh__get_issue": {"mode": "allow", "argConstraints": {"repo": "acme/*"}}}},
	}
	d.decision == "deny"
	contains(d.reason, "repo")
}

test_constraint_missing_arg_denied if {
	d := call.decision with input as {
		"tool": {"name": "searchWeb"},
		"args": {"query": "x", "specificDomain": null},
		"runtimeContext": {"grants": {"searchWeb": {"mode": "allow", "argConstraints": {"specificDomain": "vercel.com"}}}},
	}
	d.decision == "deny"
}

test_two_violations_one_reason if {
	d := call.decision with input as {
		"tool": {"name": "mcp__x__y"},
		"args": {"a": "1", "b": "2"},
		"runtimeContext": {"grants": {"mcp__x__y": {"mode": "allow", "argConstraints": {"a": "z", "b": "z"}}}},
	}
	d.decision == "deny"
	contains(d.reason, "`a`")
}

test_constraint_on_approve_denied_not_asked if {
	d := call.decision with input as {
		"tool": {"name": "mcp__gh__create_issue"},
		"args": {"repo": "evil/x"},
		"runtimeContext": {"grants": {"mcp__gh__create_issue": {"mode": "approve", "argConstraints": {"repo": "acme/*"}}}},
	}
	d.decision == "deny"
}

# ---------- built-in safety rules (upstream's) still apply when granted ----------

test_weather_granted_allowed if {
	call.decision.decision == "allow" with input as {"tool": {"name": "getWeather"}, "args": {"city": "Berlin"}, "runtimeContext": grants_allow("getWeather")}
}

test_bash_allowed_command if {
	call.decision.decision == "allow" with input as {
		"tool": {"name": "bash"}, "args": {"command": "ls -la"},
		"bash": {"program": "ls", "argv": ["ls", "-la"], "suspicious": false},
		"runtimeContext": grants_allow("bash"),
	}
}

test_bash_disallowed_command if {
	d := call.decision with input as {
		"tool": {"name": "bash"}, "args": {"command": "rm -rf x"},
		"bash": {"program": "rm", "argv": ["rm", "-rf", "x"], "suspicious": false},
		"runtimeContext": grants_allow("bash"),
	}
	d.decision == "deny"
	contains(d.reason, "`rm` is not an allowed command")
}

test_bash_suspicious if {
	d := call.decision with input as {
		"tool": {"name": "bash"}, "args": {"command": "ls; rm x"},
		"bash": {"program": "ls;", "argv": ["ls;", "rm", "x"], "suspicious": true},
		"runtimeContext": grants_allow("bash"),
	}
	d.decision == "deny"
	contains(d.reason, "single, simple command")
}

test_bash_path_escape if {
	d := call.decision with input as {
		"tool": {"name": "bash"}, "args": {"command": "cat /etc/passwd"},
		"bash": {"program": "cat", "argv": ["cat", "/etc/passwd"], "suspicious": false},
		"runtimeContext": grants_allow("bash"),
	}
	d.decision == "deny"
	contains(d.reason, "relative paths")
}

test_bash_ungranted if {
	d := call.decision with input as {
		"tool": {"name": "bash"}, "args": {"command": "ls"},
		"bash": {"program": "ls", "argv": ["ls"], "suspicious": false},
		"runtimeContext": {"grants": {}},
	}
	d.decision == "deny"
	contains(d.reason, "not granted")
}

test_write_file_always_denied if {
	d := call.decision with input as {"tool": {"name": "writeFile"}, "args": {"path": "a.txt", "content": "x"}, "runtimeContext": grants_allow("writeFile")}
	d.decision == "deny"
	contains(d.reason, "read-only")
}

test_read_file_relative_allowed if {
	call.decision.decision == "allow" with input as {"tool": {"name": "readFile"}, "args": {"path": "notes.txt"}, "runtimeContext": grants_allow("readFile")}
}

test_read_file_traversal_denied if {
	d := call.decision with input as {"tool": {"name": "readFile"}, "args": {"path": "../secret"}, "runtimeContext": grants_allow("readFile")}
	d.decision == "deny"
}
