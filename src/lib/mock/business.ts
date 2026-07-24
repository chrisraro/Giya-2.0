export type MockKpi = { label: string; value: string; delta: string };

export const MOCK_KPIS: MockKpi[] = [
  { label: "Visits this week", value: "128", delta: "+12% vs last week" },
  { label: "Points issued", value: "4,320", delta: "+8%" },
  { label: "Redemptions", value: "37", delta: "+5" },
  { label: "New customers", value: "24", delta: "+3" },
];

export const MOCK_WEEK_VISITS: { day: string; value: number }[] = [
  { day: "Mon", value: 14 },
  { day: "Tue", value: 18 },
  { day: "Wed", value: 22 },
  { day: "Thu", value: 16 },
  { day: "Fri", value: 24 },
  { day: "Sat", value: 28 },
  { day: "Sun", value: 12 },
];

export const MOCK_ACTIVITY: { id: string; icon: string; text: string; timeLabel: string }[] = [
  { id: "act-1", icon: "document_scanner", text: "Mia Santos scanned a receipt for ₱180", timeLabel: "2 min ago" },
  { id: "act-2", icon: "redeem", text: "Carlo Reyes redeemed Free medium milk tea", timeLabel: "18 min ago" },
  { id: "act-3", icon: "document_scanner", text: "Jenny Aquino scanned a receipt for ₱420", timeLabel: "34 min ago" },
  { id: "act-4", icon: "person_add", text: "New customer joined: Paolo Cruz", timeLabel: "1 hour ago" },
  { id: "act-5", icon: "redeem", text: "Mia Santos redeemed Free ensaymada", timeLabel: "2 hours ago" },
  { id: "act-6", icon: "document_scanner", text: "Ana Villanueva scanned a receipt for ₱95", timeLabel: "3 hours ago" },
];
