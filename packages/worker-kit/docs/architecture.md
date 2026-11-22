# worker-kit — architecture

`authorize(env, actor, action, {orgId, projectId?})` runs the baseline's two calls — membership-worker's authorization context, then policy-worker's decision — and answers false on any error. Handlers answer 404 on deny, as every baseline Worker does. `dispatch()` is a first-match [method, regex, handler] router answering 404 / 405.
