import { Link } from "react-router";

import { Page } from "../components/Page";
import { routes } from "../routes";

export function NotFoundPage() {
  return (
    <Page heading="Page not found">
      <p className="muted">This screen doesn't exist.</p>
      <Link className="button button--primary" to={routes.home}>
        Go to Home
      </Link>
    </Page>
  );
}
