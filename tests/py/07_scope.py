import math

LIMIT = 3

def is_prime(n):
    if n < 2:
        return False
    for d in range(2, int(math.sqrt(n)) + 1):
        if n % d == 0:
            return False
    return True

def count_primes(upto):
    total = 0
    for v in range(upto):
        if is_prime(v):
            total += 1
    return total

if LIMIT > 2:
    result = "big"
else:
    result = "small"
print(result)
primes = []
for v in range(30):
    if is_prime(v):
        primes.append(v)
print(primes)
print(count_primes(100), round(math.pi, 2))

def main():
    print("main", LIMIT)

if __name__ == "__main__":
    main()
