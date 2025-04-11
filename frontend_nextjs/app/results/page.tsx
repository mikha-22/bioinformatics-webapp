tsx
import React from 'react';

export default function Results() {
  return (
    <>
      <head>
        <title>Sarek Pipeline Results</title>
        <link rel="stylesheet" href="/frontend/static/results.css"></link>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css"
        ></link>
        <style>
          {`
            /* Add specific styles here if needed, or keep in results.css */
            .run-item.highlighted .card-header {
                background-color: #d1ecf1; /* Light blue highlight */
                border-left: 5px solid #007bff;
            }
            .file-list-item .file-icon {
                width: 20px; /* Ensure icons align well */
                text-align: center;
                margin