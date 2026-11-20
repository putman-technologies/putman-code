import { describe, expect, it } from "vite-plus/test";
import { reviewScreenshots, reviewCriteria } from "./reviewScreenshots.ts";
describe("PR screenshots", () => {
  it("pairs explicit labels and comparison table columns", () => {
    expect(
      reviewScreenshots(
        "| After | Before |\n|---|---|\n| ![](https://a.test/new.png) | <img src='https://a.test/old.png'> |",
      ),
    ).toEqual({ before: "https://a.test/old.png", after: "https://a.test/new.png" });
    expect(
      reviewScreenshots(
        "### Before\n![page](https://a.test/old.png)\n### After\n<img src='https://a.test/new.png'>",
      ),
    ).toEqual({ before: "https://a.test/old.png", after: "https://a.test/new.png" });
  });
  it("reads only acceptance criteria and leaves unchecked evidence unverified", () => {
    expect(
      reviewCriteria(
        "## Acceptance criteria\r\n- [x] Opens the invoice [check: Invoice navigation]\r\n- [ ] Return to page two\r\n## Notes\r\n- [x] Ignore me",
      ),
    ).toEqual([
      { label: "Opens the invoice", check: "Invoice navigation" },
      { label: "Return to page two", check: null },
    ]);
  });
  it("skips credentialed or non-web URLs and unlabelled images", () => {
    expect(
      reviewScreenshots(
        "![before](https://user:pass@x.test/a)\n<img alt='after' src='file:///tmp/foo'>\n![](https://x.test/something)",
      ),
    ).toEqual({ before: null, after: null });
  });
});
