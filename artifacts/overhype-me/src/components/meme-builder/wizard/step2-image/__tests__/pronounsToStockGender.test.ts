import { describe, it, expect } from "vitest";
import { pronounsToStockGender } from "../../util/pronounsToStockGender";

describe("pronounsToStockGender", () => {
  it("maps he/* → male", () => {
    expect(pronounsToStockGender("he/him")).toBe("male");
    expect(pronounsToStockGender("HE/HIM")).toBe("male");
  });
  it("maps she/* → female", () => {
    expect(pronounsToStockGender("she/her")).toBe("female");
  });
  it("maps everything else to neutral", () => {
    expect(pronounsToStockGender("they/them")).toBe("neutral");
    expect(pronounsToStockGender("ze/zir")).toBe("neutral");
    expect(pronounsToStockGender(null)).toBe("neutral");
    expect(pronounsToStockGender(undefined)).toBe("neutral");
    expect(pronounsToStockGender("")).toBe("neutral");
  });
});
