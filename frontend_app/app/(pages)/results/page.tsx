// File: frontend_app/app/(pages)/results/page.tsx
"use client";

// Import Suspense from React
import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from 'next/navigation';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, ArrowDownUp } from "lucide-react";

import * as api from "@/lib/api";
import { ResultRun } from "@/lib/types";
import LoadingSpinner from "@/components/common/LoadingSpinner";
import ErrorDisplay from "@/components/common/ErrorDisplay";
import RunItem from "@/components/results/RunItem";

// Keep this for now, although Suspense might make it redundant for this specific error
export const dynamic = 'force-dynamic';

// --- NEW Client Component to handle search params ---
function ResultsList({ runs, searchTerm, sortOrder }: {
    runs: ResultRun[] | undefined;
    searchTerm: string;
    sortOrder: "asc" | "desc";
}) {
    // This component uses the hook and can be suspended
    const searchParams = useSearchParams();
    const highlightedRunName = searchParams.get('highlight');

    const [expandedRun, setExpandedRun] = useState<string | null>(null);

    // Effect to expand highlighted run (runs on client)
    useEffect(() => {
        if (highlightedRunName) {
            setExpandedRun(highlightedRunName);
            setTimeout(() => {
                const element = document.getElementById(`run-${highlightedRunName}`);
                element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        } else {
            setExpandedRun(null);
        }
    }, [highlightedRunName]);

    // Filter/Sort logic moved here
    const filteredAndSortedRuns = useMemo(() => {
        let filtered = runs ?? [];
        if (searchTerm) {
            filtered = filtered.filter((run) =>
                run.name.toLowerCase().includes(searchTerm.toLowerCase())
            );
        }
        filtered.sort((a, b) => {
            const timeA = a.modified_time ?? 0;
            const timeB = b.modified_time ?? 0;
            return sortOrder === "desc" ? timeB - timeA : timeA - timeB;
        });
        return filtered;
    }, [runs, searchTerm, sortOrder]);

    const handleExpandToggle = (runName: string, isOpening: boolean) => {
        setExpandedRun(isOpening ? runName : null);
    };

    // Render the actual list
    return (
        <>
            {filteredAndSortedRuns.length === 0 ? (
                <p className="text-center text-muted-foreground py-10">
                    {searchTerm ? "No matching results found." : "No pipeline results available yet."}
                </p>
            ) : (
                <div className="space-y-4">
                    {filteredAndSortedRuns.map((run) => (
                        <div key={run.name} id={`run-${run.name}`}>
                            <RunItem
                                run={run}
                                isHighlighted={run.name === highlightedRunName}
                                isExpanded={expandedRun === run.name}
                                onExpandToggle={handleExpandToggle}
                            />
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}
// --- END NEW Client Component ---


// --- Main Page Component ---
export default function ResultsPage() {
    // State managed here, passed down to ResultsList
    const [searchTerm, setSearchTerm] = useState("");
    const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

    // Data fetching remains here
    const { data: runs, isLoading, isError, error } = useQuery<ResultRun[], Error>({
        queryKey: ["resultsList"],
        queryFn: api.getResultsList,
    });

    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold ml-2">Pipeline Results</h1>

            {/* Controls: Search and Sort */}
            <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative flex-grow">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        type="search"
                        placeholder="Search run names..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-8 w-full"
                        disabled={isLoading}
                    />
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
                        className="cursor-pointer"
                        disabled={isLoading}
                    >
                        <ArrowDownUp className="mr-2 h-4 w-4" />
                        Sort by Date ({sortOrder === "asc" ? "Oldest" : "Newest"} First)
                    </Button>
                </div>
            </div>

            {/* Loading State */}
            {isLoading && <div className="text-center py-10"><LoadingSpinner label="Loading results..." size="lg" /></div>}

            {/* Error State */}
            {isError && <ErrorDisplay error={error} title="Failed to load results" />}

            {/* Results List Area - Wrap the component using useSearchParams in Suspense */}
            {!isLoading && !isError && (
                <Suspense fallback={<div className="text-center py-10"><LoadingSpinner label="Loading results view..." /></div>}>
                    <ResultsList runs={runs} searchTerm={searchTerm} sortOrder={sortOrder} />
                </Suspense>
            )}
        </div>
    );
}
