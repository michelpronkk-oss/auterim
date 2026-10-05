"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { ProviderMark } from "@/app/_home/marks";
import { Chevron, tools as s } from "../tool-parts";

type Service = { slug: string; name: string; total: number };

/** Searchable service picker. Picking a service loads its coverage via ?provider=. */
export function ServicePicker({ services, selected }: { services: Service[]; selected?: string }) {
  const router = useRouter();
  const current = services.find((service) => service.slug === selected);
  const [query, setQuery] = useState(current?.name ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const labelId = useId();
  const listId = useId();

  const q = query.trim().toLowerCase();
  const list =
    q && q !== current?.name.toLowerCase()
      ? services.filter((service) => service.name.toLowerCase().includes(q))
      : services;
  const showMark = Boolean(current) && query === current?.name;

  const pick = (service: Service) => {
    setQuery(service.name);
    setOpen(false);
    inputRef.current?.blur();
    if (service.slug !== selected) {
      router.push(`/tools/dependency-exposure?provider=${encodeURIComponent(service.slug)}`, {
        scroll: false,
      });
    }
  };

  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(open ? Math.min(active + 1, list.length - 1) : 0);
      setOpen(true);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(active - 1, 0));
    } else if (event.key === "Enter") {
      if (open && list[active]) {
        event.preventDefault();
        pick(list[active]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={s.combo}>
      <label id={labelId} htmlFor={inputId} className={`${s.label} ${s.formLabel}`}>
        SERVICE
      </label>
      <div className={`${s.field} ${s.comboField}`}>
        {showMark && current ? (
          <ProviderMark provider={current.name} size={28} />
        ) : (
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 20 20"
            style={{ flex: "none" }}
          >
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="#5A6577" strokeWidth="1.6" />
            <path d="M13 13l4 4" stroke="#5A6577" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        )}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && list[active] ? `${listId}-${list[active].slug}` : undefined
          }
          placeholder="Search services"
          className={s.input}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={(event) => {
            event.target.select();
            setOpen(true);
            setActive(0);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Show all services"
          className={s.comboToggle}
          onMouseDown={(event) => {
            event.preventDefault();
            if (open) {
              setOpen(false);
            } else {
              inputRef.current?.focus();
            }
          }}
        >
          <Chevron />
        </button>
      </div>
      {open ? (
        <ul id={listId} role="listbox" aria-labelledby={labelId} className={s.listbox}>
          {list.map((service, i) => (
            <li
              key={service.slug}
              id={`${listId}-${service.slug}`}
              role="option"
              aria-selected={service.slug === selected}
              data-active={i === active || undefined}
              className={s.option}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(service);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <ProviderMark provider={service.name} size={28} />
              <span>{service.name}</span>
              <span className={s.optionCount}>
                {service.total} source{service.total === 1 ? "" : "s"}
              </span>
            </li>
          ))}
          {list.length === 0 ? (
            <li role="presentation" className={s.noMatch}>
              No service matches &ldquo;{query}&rdquo;.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
