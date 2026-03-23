import { NextResponse } from "next/server";

const ALLOWED_HOSTNAMES = new Set([
  "cdn.cloudflare.steamstatic.com",
  "lain.bgm.tv",
  "img.bgm.tv",
  "image.tmdb.org",
  "wsrv.nl",
]);

function normalizeRemoteUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = normalizeRemoteUrl(searchParams.get("url"));

  if (!url) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_image_url",
      },
      { status: 400 }
    );
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "myanime-image-proxy/1.0",
      },
      cache: "force-cache",
    });

    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "image_fetch_failed",
          status: upstream.status,
        },
        { status: 502 }
      );
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const body = await upstream.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "image_proxy_failed",
      },
      { status: 500 }
    );
  }
}
