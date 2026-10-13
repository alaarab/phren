import { describe, expect, it } from "vitest";
import { inQuietHours } from "../ui/shell/quiet.js";

const at = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00`);

describe("quiet hours", () => {
  it("covers a window that crosses midnight", () => {
    expect(inQuietHours(at("23:30"), "22:00", "07:00")).toBe(true);
    expect(inQuietHours(at("06:59"), "22:00", "07:00")).toBe(true);
    expect(inQuietHours(at("07:00"), "22:00", "07:00")).toBe(false);
    expect(inQuietHours(at("12:00"), "22:00", "07:00")).toBe(false);
  });

  it("covers a same-day window and treats equal ends or bad times as never", () => {
    expect(inQuietHours(at("13:15"), "12:30", "14:00")).toBe(true);
    expect(inQuietHours(at("14:00"), "12:30", "14:00")).toBe(false);
    expect(inQuietHours(at("13:15"), "09:00", "09:00")).toBe(false);
    expect(inQuietHours(at("13:15"), "", "07:00")).toBe(false);
  });
});
