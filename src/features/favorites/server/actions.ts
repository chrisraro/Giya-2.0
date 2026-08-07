"use server";

import { revalidatePath } from "next/cache";
import { addFavorite, removeFavorite } from "./repo";

export async function toggleFavoriteAction(businessId: string, currentIsFavorite: boolean) {
  if (currentIsFavorite) {
    const res = await removeFavorite(businessId);
    revalidatePath("/favorites");
    revalidatePath("/home");
    return res;
  } else {
    const res = await addFavorite(businessId);
    revalidatePath("/favorites");
    revalidatePath("/home");
    return res;
  }
}
