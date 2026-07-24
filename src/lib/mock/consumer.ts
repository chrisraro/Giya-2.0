export type MockBusiness = {
  id: string;
  name: string;
  type: string;
  city: string;
  distanceKm: number;
  pointsRate: string;
};

export type MockBalance = {
  businessId: string;
  businessName: string;
  points: number;
  stampsEarned: number;
  stampsTarget: number;
  nextReward: string;
};

export type MockTransaction = {
  id: string;
  businessName: string;
  kind: "earn" | "redeem";
  points: number;
  description: string;
  dateLabel: string;
};

export type MockReward = {
  id: string;
  businessName: string;
  name: string;
  pointsCost: number;
  status: "available" | "claimed";
};

export const MOCK_USER: { name: string; firstName: string; city: string; initials: string } = {
  name: "Mia Santos",
  firstName: "Mia",
  city: "Cebu City",
  initials: "MS",
};

export const MOCK_BUSINESSES: MockBusiness[] = [
  { id: "biz-kape-diaria", name: "Kape Diaria", type: "Cafe", city: "Cebu City", distanceKm: 0.6, pointsRate: "1 pt per ₱50" },
  { id: "biz-lola-nena", name: "Lola Nena's Bakeshop", type: "Bakery", city: "Cebu City", distanceKm: 1.2, pointsRate: "1 pt per ₱40" },
  { id: "biz-seoul-grill", name: "Seoul Grill PH", type: "Korean BBQ", city: "Mandaue City", distanceKm: 3.4, pointsRate: "1 pt per ₱100" },
  { id: "biz-chill-cup", name: "Chill Cup Milk Tea", type: "Milk tea", city: "Cebu City", distanceKm: 0.9, pointsRate: "1 pt per ₱30" },
  { id: "biz-tapsi-marco", name: "Tapsi ni Marco", type: "Carinderia", city: "Cebu City", distanceKm: 1.8, pointsRate: "1 pt per ₱50" },
];

export const MOCK_BALANCES: MockBalance[] = [
  { businessId: "biz-kape-diaria", businessName: "Kape Diaria", points: 1250, stampsEarned: 3, stampsTarget: 5, nextReward: "Free latte" },
  { businessId: "biz-lola-nena", businessName: "Lola Nena's Bakeshop", points: 480, stampsEarned: 6, stampsTarget: 10, nextReward: "Free ensaymada" },
  { businessId: "biz-chill-cup", businessName: "Chill Cup Milk Tea", points: 860, stampsEarned: 8, stampsTarget: 8, nextReward: "Free medium milk tea" },
  { businessId: "biz-tapsi-marco", businessName: "Tapsi ni Marco", points: 210, stampsEarned: 2, stampsTarget: 6, nextReward: "Free rice bowl" },
];

export const MOCK_TRANSACTIONS: MockTransaction[] = [
  { id: "txn-1", businessName: "Kape Diaria", kind: "earn", points: 120, description: "Iced spanish latte, medium", dateLabel: "Today, 8:14 AM" },
  { id: "txn-2", businessName: "Chill Cup Milk Tea", kind: "redeem", points: -300, description: "Redeemed: Free medium milk tea", dateLabel: "Yesterday, 4:32 PM" },
  { id: "txn-3", businessName: "Lola Nena's Bakeshop", kind: "earn", points: 60, description: "Pandesal and ensaymada, dozen", dateLabel: "Yesterday, 7:05 AM" },
  { id: "txn-4", businessName: "Tapsi ni Marco", kind: "earn", points: 90, description: "Tapsilog and iced tea", dateLabel: "Jul 21, 12:10 PM" },
  { id: "txn-5", businessName: "Seoul Grill PH", kind: "earn", points: 210, description: "Samgyupsal set, 2 pax", dateLabel: "Jul 19, 7:48 PM" },
  { id: "txn-6", businessName: "Kape Diaria", kind: "redeem", points: -500, description: "Redeemed: Free latte", dateLabel: "Jul 15, 9:02 AM" },
  { id: "txn-7", businessName: "Kape Diaria", kind: "earn", points: 150, description: "Hot americano and croissant", dateLabel: "Jul 12, 8:40 AM" },
];

export const MOCK_REWARDS: MockReward[] = [
  { id: "rwd-1", businessName: "Kape Diaria", name: "Free latte", pointsCost: 500, status: "available" },
  { id: "rwd-2", businessName: "Chill Cup Milk Tea", name: "Free medium milk tea", pointsCost: 300, status: "claimed" },
  { id: "rwd-3", businessName: "Lola Nena's Bakeshop", name: "Free ensaymada", pointsCost: 200, status: "available" },
  { id: "rwd-4", businessName: "Tapsi ni Marco", name: "Free rice bowl", pointsCost: 350, status: "available" },
  { id: "rwd-5", businessName: "Seoul Grill PH", name: "Free side dish upgrade", pointsCost: 600, status: "claimed" },
];
