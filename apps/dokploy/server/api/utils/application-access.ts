import { findApplicationById } from "@dokploy/server";
import { TRPCError } from "@trpc/server";

// Role checks let an owner or admin through without looking at whose
// application it is, so anything addressed by an application or deployment id
// must also be checked against the organization the caller is working in.
export const assertApplicationInActiveOrganization = async (
	ctx: { session: { activeOrganizationId: string } },
	applicationId: string,
) => {
	const application = await findApplicationById(applicationId);
	if (
		application.environment.project.organizationId !==
		ctx.session.activeOrganizationId
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this application",
		});
	}
	return application;
};
