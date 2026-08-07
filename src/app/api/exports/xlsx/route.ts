import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { PlanSchema, TripRequestSchema } from "@/lib/domain";
import { formatDistance, formatDuration } from "@/lib/utils";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const plan = PlanSchema.parse(body.plan);
    const trip = TripRequestSchema.parse(body.request);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "去野旅行规划";
    const sheet = workbook.addWorksheet("详细行程", { views: [{ state: "frozen", ySplit: 3 }] });
    sheet.mergeCells("A1:H1");
    sheet.getCell("A1").value = `${trip.destination} · ${plan.name}`;
    sheet.getCell("A1").font = { size: 18, bold: true, color: { argb: "FF123F36" } };
    sheet.getCell("A2").value = `共 ${trip.days} 天｜${plan.tagline}`;
    sheet.columns = [
      { header: "天数", key: "day", width: 9 }, { header: "当天主题", key: "title", width: 25 }, { header: "路线", key: "route", width: 42 },
      { header: "里程", key: "distance", width: 12 }, { header: "自驾时间", key: "drive", width: 14 }, { header: "详细玩法", key: "play", width: 55 },
      { header: "住宿区域", key: "stay", width: 22 }, { header: "提醒", key: "issues", width: 35 },
    ];
    sheet.getRow(3).values = ["天数", "当天主题", "路线", "里程", "自驾时间", "详细玩法", "住宿区域", "提醒"];
    sheet.getRow(3).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF123F36" } };
    for (const day of plan.days) {
      sheet.addRow({
        day: `D${day.day}`, title: day.title, route: day.activities.map((item) => item.place.name).join(" → "), distance: formatDistance(day.totalDistanceM),
        drive: formatDuration(day.totalDriveS), play: day.activities.map((item) => `${item.place.name}：${item.place.knowledge.playTips.join("；")}`).join("\n"),
        stay: `${day.stay}\n${day.stayReason}`, issues: day.issues.map((issue) => issue.message).join("；") || "无",
      });
    }
    sheet.eachRow((row, number) => { if (number >= 3) { row.alignment = { vertical: "top", wrapText: true }; row.height = number === 3 ? 24 : 58; } });
    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(Buffer.from(buffer), {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${trip.destination}-${plan.name}.xlsx`)}` },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Excel 导出失败" }, { status: 400 });
  }
}
