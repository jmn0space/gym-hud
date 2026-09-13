import { Page } from "../components/Page";
import { UnavailableState } from "../components/UnavailableState";

export function HistoryPage() {
  return (
    <Page heading="History">
      <UnavailableState title="No history yet">
        Sessions can't be recorded in this version, so there is nothing to list.
      </UnavailableState>
    </Page>
  );
}
