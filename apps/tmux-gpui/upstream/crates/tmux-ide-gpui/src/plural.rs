//! Count labels with the noun form that matches the count ("1 machine", "2 machines").
use std::fmt::Display;

pub(crate) fn count<N: Copy + Display + PartialEq + From<u8>>(
    n: N,
    one: &str,
    many: &str,
) -> String {
    format!("{n} {}", if n == N::from(1) { one } else { many })
}

#[cfg(test)]
mod tests {
    use super::count;

    #[test]
    fn singular_only_for_exactly_one() {
        assert_eq!(count(0usize, "machine", "machines"), "0 machines");
        assert_eq!(count(1usize, "machine", "machines"), "1 machine");
        assert_eq!(count(2u64, "machine", "machines"), "2 machines");
    }
}
