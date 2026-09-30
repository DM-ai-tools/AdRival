"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { currentReturnPath, withReturn } from "@/lib/returnTo";

/**
 * A link to a detail page that remembers where the user came from, so the
 * page's Back and breadcrumb return here (same run, same tab, or History).
 */
export function ReturnLink({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [full, setFull] = useState(href);
  useEffect(() => {
    setFull(withReturn(href, currentReturnPath()));
  }, [href]);
  return (
    <Link
      href={full}
      className={className}
      title={title}
      onClick={(e) => {
        // A new tab keeps the rendered link; a plain click uses the address
        // as it is now (the tab or run may have changed since render).
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        router.push(withReturn(href, currentReturnPath()));
      }}
    >
      {children}
    </Link>
  );
}
