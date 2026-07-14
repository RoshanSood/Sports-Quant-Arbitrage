import { NextResponse } from "next/server";
import { BOOKS } from "@/lib/props/books";

// Supported books: categories, abbreviations, display order, anchor capability.
export async function GET() {
  return NextResponse.json({ books: BOOKS });
}
