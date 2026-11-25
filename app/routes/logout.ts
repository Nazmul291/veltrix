import { redirect, type ActionFunctionArgs } from "@remix-run/node";
import { assertSameOrigin, logout } from "~/services/session.server";

// POST only: a GET logout would let any page sign users out with an <img> tag.
export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  return logout(request);
}

export const loader = () => redirect("/");
