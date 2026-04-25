import { describe, it, expect } from "vitest";
import { msToHuman } from "@/pages/admin/_configShared";

describe("msToHuman", () => {
  describe("invalid / edge inputs", () => {
    it("returns empty string for negative values", () => {
      expect(msToHuman(-1)).toBe("");
      expect(msToHuman(-1000)).toBe("");
    });

    it("returns empty string for Infinity", () => {
      expect(msToHuman(Infinity)).toBe("");
    });

    it("returns empty string for NaN", () => {
      expect(msToHuman(NaN)).toBe("");
    });
  });

  describe("zero", () => {
    it("returns '0 ms' for exactly 0", () => {
      expect(msToHuman(0)).toBe("0 ms");
    });
  });

  describe("sub-second (< 1 000 ms)", () => {
    it("returns raw ms for 1 ms", () => {
      expect(msToHuman(1)).toBe("1 ms");
    });

    it("returns raw ms for 500 ms", () => {
      expect(msToHuman(500)).toBe("500 ms");
    });

    it("returns raw ms for 999 ms", () => {
      expect(msToHuman(999)).toBe("999 ms");
    });
  });

  describe("seconds (1 000 ms – 59 999 ms)", () => {
    it("returns singular 'second' for exactly 1 000 ms", () => {
      expect(msToHuman(1_000)).toBe("≈ 1 second");
    });

    it("returns plural 'seconds' for 5 000 ms", () => {
      expect(msToHuman(5_000)).toBe("≈ 5 seconds");
    });

    it("returns plural 'seconds' for 30 000 ms", () => {
      expect(msToHuman(30_000)).toBe("≈ 30 seconds");
    });

    it("rounds fractional seconds correctly (1 500 ms → 2 seconds)", () => {
      expect(msToHuman(1_500)).toBe("≈ 2 seconds");
    });

    it("rounds down fractional seconds (1 499 ms → 1 second)", () => {
      expect(msToHuman(1_499)).toBe("≈ 1 second");
    });
  });

  describe("minutes (60 000 ms – 3 599 999 ms)", () => {
    it("returns singular 'minute' for exactly 60 000 ms", () => {
      expect(msToHuman(60_000)).toBe("≈ 1 minute");
    });

    it("returns plural 'minutes' for 2 minutes (120 000 ms)", () => {
      expect(msToHuman(120_000)).toBe("≈ 2 minutes");
    });

    it("returns fractional minutes for 90 000 ms (1.5 min)", () => {
      expect(msToHuman(90_000)).toBe("≈ 1.5 minutes");
    });

    it("returns fractional minutes for 5 minutes 30 seconds (330 000 ms)", () => {
      expect(msToHuman(330_000)).toBe("≈ 5.5 minutes");
    });

    it("returns plural 'minutes' for 10 minutes (600 000 ms)", () => {
      expect(msToHuman(600_000)).toBe("≈ 10 minutes");
    });

    it("rounds to one decimal place for non-tidy values (e.g. 100 000 ms ≈ 1.7 min)", () => {
      expect(msToHuman(100_000)).toBe("≈ 1.7 minutes");
    });
  });

  describe("hours (≥ 3 600 000 ms)", () => {
    it("returns singular 'hour' for exactly 1 hour (3 600 000 ms)", () => {
      expect(msToHuman(3_600_000)).toBe("≈ 1 hour");
    });

    it("returns plural 'hours' for 2 hours (7 200 000 ms)", () => {
      expect(msToHuman(7_200_000)).toBe("≈ 2 hours");
    });

    it("returns fractional hours for 1.5 hours (5 400 000 ms)", () => {
      expect(msToHuman(5_400_000)).toBe("≈ 1.5 hours");
    });

    it("returns fractional hours for 24 hours (86 400 000 ms)", () => {
      expect(msToHuman(86_400_000)).toBe("≈ 24 hours");
    });

    it("rounds to one decimal place for non-tidy values (e.g. 9 000 000 ms ≈ 2.5 hours)", () => {
      expect(msToHuman(9_000_000)).toBe("≈ 2.5 hours");
    });
  });
});
