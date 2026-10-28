export class KillSwitch {
  private readonly triggers = new Set<string>();
  trip(reason: string) {
    this.triggers.add(reason);
  }
  snapshot() {
    return { active: this.triggers.size > 0, reasons: [...this.triggers] };
  }
  reset(healthPassed: boolean) {
    if (!healthPassed)
      throw new Error(
        "Không thể khôi phục khi kiểm tra an toàn bắt buộc còn thất bại",
      );
    this.triggers.clear();
  }
  restore(reasons: string[]) {
    this.triggers.clear();
    for (const reason of reasons) this.triggers.add(reason);
  }
}
