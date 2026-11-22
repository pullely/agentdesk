import { authorize } from "@saas/policy-engine";
import type {
  AuthorizationRequest,
  MembershipFact,
  PolicyMembershipFact,
  PolicySubject,
  PolicyResource,
} from "@saas/contracts/policy";
import type { TenancyRole } from "@saas/contracts/tenancy";

const subject: PolicySubject = { type: "user", id: "usr_abc123" };

function orgFact(role: string, orgId: string): MembershipFact {
  return { kind: "role_assignment", role: role as TenancyRole, scope: { kind: "organization", orgId } };
}

function projectFact(role: string, orgId: string, projectId: string): MembershipFact {
  return {
    kind: "role_assignment",
    role: role as TenancyRole,
    scope: { kind: "project", orgId, projectId },
  };
}

function authReq(
  action: string,
  orgId: string,
  memberships: PolicyMembershipFact[],
  projectId?: string,
): AuthorizationRequest {
  const resource: PolicyResource = { kind: "organization", orgId };
  if (projectId) resource.projectId = projectId;
  return {
    subject,
    action,
    resource,
    context: { memberships },
  };
}

const allow = (action: string, facts: PolicyMembershipFact[], projectId?: string, orgId = "org_1") =>
  authorize(authReq(action, orgId, facts, projectId)).allow;

describe("authorize – agentdesk bot actions (AD-2)", () => {
  it("owner and admin hold every bot action", () => {
    for (const role of ["owner", "admin"]) {
      const facts = [orgFact(role, "org_1")];
      expect(allow("bot.config.write", facts, "prj_1")).toBe(true);
      expect(allow("bot.publish", facts, "prj_1")).toBe(true);
      expect(allow("run.read", facts, "prj_1")).toBe(true);
      expect(allow("connector.manage", facts)).toBe(true);
      expect(allow("provider_key.manage", facts)).toBe(true);
    }
  });
  it("builder edits and tests a bot but cannot publish or manage keys and connectors", () => {
    const facts = [orgFact("builder", "org_1")];
    expect(allow("bot.config.write", facts, "prj_1")).toBe(true);
    expect(allow("run.read", facts, "prj_1")).toBe(true);
    expect(allow("bot.publish", facts, "prj_1")).toBe(false);
    expect(allow("connector.manage", facts)).toBe(false);
    expect(allow("provider_key.manage", facts)).toBe(false);
  });
  it("viewer only reads runs", () => {
    const facts = [orgFact("viewer", "org_1")];
    expect(allow("run.read", facts, "prj_1")).toBe(true);
    expect(allow("bot.config.write", facts, "prj_1")).toBe(false);
  });
  it("bot actions are asked about one project", () => {
    const facts = [orgFact("owner", "org_1")];
    expect(allow("bot.config.write", facts)).toBe(false);
  });
  it("a project admin publishes their own bot, not another project's", () => {
    const facts = [projectFact("project_admin", "org_1", "prj_1")];
    expect(allow("bot.publish", facts, "prj_1")).toBe(true);
    expect(allow("bot.publish", facts, "prj_2")).toBe(false);
    expect(allow("provider_key.manage", facts)).toBe(false);
  });
  it("nothing crosses orgs", () => {
    expect(allow("run.read", [orgFact("owner", "org_1")], "prj_1", "org_2")).toBe(false);
  });
});
