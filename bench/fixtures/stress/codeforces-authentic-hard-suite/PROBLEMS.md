# Problems

All indices are 1-based unless stated otherwise. Print answers exactly as requested.

## H01 - Timeline Connectivity

You are given an initially empty undirected graph with `n` vertices and `q` events. Events are:

- `+ u v`: add edge `{u,v}`. The edge is not active immediately before this event.
- `- u v`: remove edge `{u,v}`. The edge is active immediately before this event.
- `? u v`: ask whether `u` and `v` are connected by active edges.

For each query, print `YES` or `NO`.

Constraints: `1 <= n,q <= 200000`.

## H02 - Distinct Intervals

Given an array `a` of length `n`, answer `q` queries. Each query gives `l r`; print the number of distinct values in `a[l..r]`.

Constraints: `1 <= n,q <= 200000`, values fit in signed 32-bit integers.

## H03 - Prefix Substring Wealth

Given a lowercase string `s`, for every prefix `s[1..i]` print the number of distinct non-empty substrings of that prefix.

Constraints: `1 <= |s| <= 200000`.

## H04 - Modular Product

Given two polynomials `A` and `B` over modulo `998244353`, print all coefficients of `A*B`.

Input: `n m`, then `n` coefficients of `A`, then `m` coefficients of `B`.

Constraints: `1 <= n,m <= 262144`.

## H05 - Tree Path Range

You are given a tree with initial vertex weights and `q` operations:

- `add u v x`: add `x` to every vertex on the path from `u` to `v`.
- `max u v`: print the maximum weight on the path from `u` to `v`.

Constraints: `1 <= n,q <= 200000`, weights and updates fit in signed 64-bit integers.

## H06 - Minimum Perfect Pairing

Given an `n x n` cost matrix, choose exactly one entry from each row and each column with minimum total cost. Print that minimum cost.

Constraints: `1 <= n <= 80`.

## H07 - Dense Matching

Given a bipartite graph with `L` left vertices, `R` right vertices, and `m` edges, print the size of a maximum matching.

Constraints: `1 <= L,R <= 2000`, `0 <= m <= 200000`.

## H08 - Forbidden Walks

You are given a directed graph with lowercase labels on edges. Count walks of exactly `K` edges from vertex `1` to vertex `n` whose label string does not contain pattern `p` as a substring. Print the answer modulo `1000000007`.

Input: `n m K p`, then `m` lines `u v c`.

Constraints: `1 <= n <= 35`, `1 <= |p| <= 12`, `0 <= K <= 10^18`.

## H09 - Nearest Marked Vertex

You are given a tree. Initially only vertex `1` is marked. Operations:

- `mark u`: mark vertex `u`.
- `dist u`: print the distance from `u` to the nearest marked vertex.

Constraints: `1 <= n,q <= 200000`.

## H10 - Far Recurrence

For a linear recurrence of order `k`,

```text
a_i = c_0*a_{i-1} + c_1*a_{i-2} + ... + c_{k-1}*a_{i-k}
```

given coefficients `c`, initial values `a_0..a_{k-1}`, and index `n`, print `a_n mod 1000000007`.

Constraints: `1 <= k <= 200`, `0 <= n <= 10^18`.
