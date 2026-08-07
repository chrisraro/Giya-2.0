import { NextResponse } from "next/server";
import { parsePosPayload } from "@/features/pos/adapter";

export async function POST(request: Request) {
  try {
    const raw = await request.json();
    const parsed = parsePosPayload(raw);

    return NextResponse.json({
      success: true,
      data: {
        transactionId: parsed.transactionId,
        storeId: parsed.storeId,
        totalCentavos: parsed.totalCentavos,
        itemCount: parsed.items.length,
        status: "queued",
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Invalid POS payload" },
      { status: 400 },
    );
  }
}
