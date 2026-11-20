import { describe, expect, it } from "vite-plus/test";
import { reviewScreenshots } from "./reviewScreenshots.ts";
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
  it("skips credentialed or non-web URLs and unlabelled images", () => {
    expect(
      reviewScreenshots(
        "![before](https://user:pass@x.test/a)\n<img alt='after' src='file:///tmp/foo'>\n![](https://x.test/something)",
      ),
    ).toEqual({ before: null, after: null });
  });
});
