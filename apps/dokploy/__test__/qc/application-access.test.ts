import { beforeEach, describe, expect, test, vi } from "vitest";

const findApplicationById = vi.fn();

vi.mock("@dokploy/server", () => ({
	findApplicationById: (...args: unknown[]) => findApplicationById(...args),
}));

import { assertApplicationInActiveOrganization } from "@/server/api/utils/application-access";

const ctx = (activeOrganizationId: string) => ({
	session: { activeOrganizationId },
});

describe("assertApplicationInActiveOrganization", () => {
	beforeEach(() => {
		findApplicationById.mockReset();
		findApplicationById.mockResolvedValue({
			applicationId: "app1",
			environment: { project: { organizationId: "org-a" } },
		});
	});

	test("returns the application when it belongs to the caller's organization", async () => {
		const application = await assertApplicationInActiveOrganization(
			ctx("org-a"),
			"app1",
		);
		expect(application.applicationId).toBe("app1");
	});

	test("refuses an application of another organization", async () => {
		await expect(
			assertApplicationInActiveOrganization(ctx("org-b"), "app1"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
